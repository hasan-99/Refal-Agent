#!/usr/bin/env node
// Generate the Deno-compatible ESM mirrors the edge function imports.
//
// WHY THIS EXISTS. The edge function is Deno and cannot `require()` a CommonJS
// module, so every safety check it needs has to exist beside it as ESM. Until
// now those copies were written BY HAND, and they drifted exactly as you would
// expect:
//
//   * index.ts carried its own `containsProhibitedClaim` that predated the
//     2026-10-09 guardrail fixes. It let through "We have a 100% success rate",
//     "موافقة مضمونة للجميع" and "Σίγουρη έγκριση για εσάς" — all three blocked
//     by src/refalcoAnswer.js — and it blocked "I cannot provide tax advice",
//     which the source deliberately exempts as a safe disclaimer.
//   * responsePolicy.mjs was missing two alternatives of
//     UNCONSENTED_CONTACT_COMMITMENT, so "A specialist will contact you
//     shortly" passed on the edge and blocked in src.
//
// Both are fail-opens on a customer-reachable path, and no test touched either
// copy. So the copies are now EXTRACTED VERBATIM from the CommonJS source
// rather than retyped, and src/mirrorParity.test.js runs both implementations
// over a shared corpus and fails the build the moment their verdicts differ.
//
//   node scripts/generateEdgeMirrors.js            # rewrite the mirrors
//   node scripts/generateEdgeMirrors.js --check    # exit 1 if any is stale

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const EDGE = path.join(REPO, "supabase", "functions", "rafa-agent-api");

/**
 * Pull a top-level `function NAME(...) {...}` or `const NAME = ...;` out of a
 * source file verbatim, by line. Relies on the repo's consistent formatting:
 * top-level declarations start at column 0 and a function's closing brace is
 * also at column 0. Throws rather than guessing if the shape is unexpected,
 * because a silently truncated safety regex is the worst possible output.
 */
function extract(sourcePath, name) {
  const lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
  const fnStart = lines.findIndex((line) => line.startsWith(`function ${name}(`));
  if (fnStart !== -1) {
    const end = lines.findIndex((line, i) => i > fnStart && line === "}");
    if (end === -1) throw new Error(`${name}: no closing brace at column 0 in ${sourcePath}`);
    return lines.slice(fnStart, end + 1).join("\n");
  }
  const constStart = lines.findIndex((line) => line.startsWith(`const ${name} = `));
  if (constStart === -1) throw new Error(`${name}: not found as a top-level function or const in ${sourcePath}`);
  if (!lines[constStart].trimEnd().endsWith(";")) {
    throw new Error(`${name}: multi-line const is not supported by this extractor`);
  }
  return lines[constStart];
}

const BANNER = (sources) => `// GENERATED FILE — do not edit by hand.
// Source: ${sources.join(", ")}
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.
`;

const TARGETS = [
  {
    file: "responsePolicy.mjs",
    sources: ["src/responsePolicy.js"],
    build() {
      const src = path.join(REPO, "src", "responsePolicy.js");
      return [
        BANNER(["src/responsePolicy.js"]),
        extract(src, "UNCONSENTED_CONTACT_COMMITMENT"),
        extract(src, "CONTACT_CAPABILITY_OFFER"),
        extract(src, "EXPLICIT_PERMISSION_QUESTION"),
        "",
        extract(src, "containsUnconsentedContactCommitment").replace(/^function /, "export function "),
        ""
      ].join("\n");
    }
  },
  {
    file: "refalcoAnswer.mjs",
    sources: ["src/refalcoAnswer.js"],
    build() {
      const src = path.join(REPO, "src", "refalcoAnswer.js");
      return [
        BANNER(["src/refalcoAnswer.js"]),
        extract(src, "removeSafeDisclaimerClauses"),
        "",
        extract(src, "containsProhibitedClaim").replace(/^function /, "export function "),
        ""
      ].join("\n");
    }
  }
];

const check = process.argv.includes("--check");
let stale = 0;

for (const target of TARGETS) {
  const file = path.join(EDGE, target.file);
  const next = target.build();
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (check) {
    if (current !== next) {
      stale += 1;
      console.error(`STALE: supabase/functions/rafa-agent-api/${target.file} no longer matches ${target.sources.join(", ")}`);
    }
    continue;
  }
  fs.writeFileSync(file, next, "utf8");
  console.log(`wrote supabase/functions/rafa-agent-api/${target.file} (${next.length} bytes)`);
}

if (check) {
  if (stale) {
    console.error("Run: node scripts/generateEdgeMirrors.js");
    process.exit(1);
  }
  console.log("all edge mirrors are in sync");
}
