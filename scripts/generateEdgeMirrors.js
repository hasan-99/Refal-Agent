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

/**
 * Mirror a WHOLE CommonJS module as ESM.
 *
 * `extract()` above is line-based and deliberately refuses a multi-line `const`,
 * which rules it out for src/claimPolicy.js and src/language.js — both are built
 * almost entirely out of multi-line frozen tables and rule arrays. Copying only
 * the parts it can read would silently truncate a safety classifier, which is
 * the exact failure mode this whole script exists to prevent.
 *
 * So a whole module is converted instead, by a transform with no judgement in
 * it. EXACTLY three kinds of line are rewritten:
 *
 *   1. a top-level `const { a, b } = require("./x");`  ->  `import { a, b } from "./x.mjs";`
 *   2. the trailing `module.exports = { ... };` block  ->  dropped
 *   3. an `export { ...exportNames };` appended at the end
 *
 * Every other byte is carried over untouched — no reformatting, no re-indenting,
 * no "tidying". That verbatim property is what makes the mirror trustworthy and
 * what lets src/mirrorParity.test.js treat a divergence as a real defect rather
 * than a transcription artefact.
 *
 * Anything the transform does not recognise is a hard error, never a guess: an
 * unmapped require, a non-destructured require, a require below the top level, a
 * missing or renamed export, a `module.exports` that is not a plain shorthand
 * object. Failing the generator is cheap; shipping a half-copied safety module
 * to a customer-reachable path is not.
 */
// `exportNames` is OPTIONAL and defaults to everything the source exports.
//
// It used to be a required hand-written list per target, and that list went
// stale the moment `src/claimPolicy.js` gained `containsGuaranteeMarker` and
// `containsPersonalizedConclusion`: the generator ran clean, `--check` reported
// "all edge mirrors are in sync", and the edge threw
// `does not provide an export named 'containsGuaranteeMarker'` on every request.
// A hand-maintained list of names next to a generated file is the same defect
// as a hand-maintained copy of the file.
//
// Pass an explicit list only to deliberately export LESS than the source does;
// it is still validated against the real `module.exports` either way.
function mirrorModule(sourcePath, { importMap = {}, exportNames = null } = {}) {
  if (exportNames !== null && (!Array.isArray(exportNames) || !exportNames.length)) {
    throw new Error(`${sourcePath}: exportNames, when given, must be a non-empty array`);
  }
  const relative = path.relative(REPO, sourcePath).split(path.sep).join("/");
  const lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);

  // --- 1. requires -> imports ----------------------------------------------
  const REQUIRE_LINE = /^const\s+\{([^}]*)\}\s*=\s*require\((["'])([^"']+)\2\);\s*$/;
  const body = lines.map((line, index) => {
    if (!line.includes("require(")) return line;
    if (!line.startsWith("const ")) {
      throw new Error(`${relative}:${index + 1}: require() outside a top-level const is not supported by this mirror`);
    }
    const match = REQUIRE_LINE.exec(line);
    if (!match) {
      throw new Error(`${relative}:${index + 1}: only \`const { a, b } = require("x");\` is supported, got: ${line}`);
    }
    const [, names, , specifier] = match;
    const target = importMap[specifier];
    if (!target) {
      throw new Error(`${relative}:${index + 1}: require("${specifier}") has no importMap entry — add one or mirror that module too`);
    }
    return `import {${names}} from "${target}";`;
  });

  // --- 2. drop the module.exports block -------------------------------------
  const exportStarts = body.reduce((found, line, index) => (line.startsWith("module.exports") ? [...found, index] : found), []);
  if (exportStarts.length !== 1) {
    throw new Error(`${relative}: expected exactly one top-level \`module.exports\`, found ${exportStarts.length}`);
  }
  const start = exportStarts[0];
  let end = start;
  if (!body[start].trimEnd().endsWith(";")) {
    end = body.findIndex((line, index) => index > start && line === "};");
    if (end === -1) throw new Error(`${relative}: module.exports block has no closing \`};\` at column 0`);
  }
  const exportBlock = body.slice(start, end + 1).join("\n");
  const inner = exportBlock.replace(/^module\.exports\s*=\s*\{/, "").replace(/\}\s*;\s*$/, "");
  const declared = inner.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of declared) {
    if (!/^[A-Za-z_$][\w$]*$/.test(entry)) {
      throw new Error(`${relative}: module.exports entry "${entry}" is not a plain shorthand name — this mirror cannot rename or compute exports`);
    }
  }
  const emitted = exportNames || declared;
  for (const name of emitted) {
    if (!declared.includes(name)) {
      throw new Error(`${relative}: "${name}" was requested as a mirror export but src exports [${declared.join(", ")}]`);
    }
  }

  // --- 3. append the ESM export list ----------------------------------------
  return [
    BANNER([relative]),
    ...body.slice(0, start),
    `export { ${emitted.join(", ")} };`,
    ...body.slice(end + 1)
  ].join("\n");
}

/**
 * Read the destructured names of selected `require` lines out of a CommonJS
 * source and emit the matching ESM imports, pointing at the `.mjs` mirrors.
 *
 * Only the specifiers listed in `specifiers` are emitted; the rest of the
 * module's requires are intentionally ignored, because the composed
 * refalcoAnswer mirror does not carry the functions that use them.
 *
 * Throws rather than guessing if a requested specifier is missing or its
 * require is not a single-line destructure — a silently truncated import list
 * is how this file produced a mirror that threw at request time.
 */
function derivedImports(sourcePath, specifiers) {
  const lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
  return specifiers.map((specifier) => {
    const pattern = new RegExp(`^const \\{([^}]*)\\} = require\\("${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\);$`);
    const line = lines.find((candidate) => pattern.test(candidate.trim()));
    if (!line) throw new Error(`derivedImports: no single-line destructured require of "${specifier}" in ${sourcePath}`);
    const names = line.trim().match(pattern)[1].split(",").map((name) => name.trim()).filter(Boolean);
    if (!names.length) throw new Error(`derivedImports: "${specifier}" is required but nothing is destructured from it`);
    if (names.some((name) => !/^[A-Za-z_$][\w$]*$/.test(name))) {
      throw new Error(`derivedImports: "${specifier}" uses renaming or defaults, which this generator does not support`);
    }
    return `import { ${names.join(", ")} } from "${specifier}.mjs";`;
  });
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
        extract(src, "CONSTRUCTION_TENDER_MESSAGE"),
        extract(src, "CONSTRUCTION_PRICE_ESTIMATE"),
        "",
        extract(src, "containsUnconsentedContactCommitment").replace(/^function /, "export function "),
        extract(src, "containsProhibitedConstructionEstimate").replace(/^function /, "export function "),
        ""
      ].join("\n");
    }
  },
  {
    // Leaf module: no imports of its own, so it mirrors with an empty importMap.
    file: "language.mjs",
    sources: ["src/language.js"],
    build() {
      return mirrorModule(path.join(REPO, "src", "language.js"), {
        exportNames: ["detectMessageLanguage", "detectExplicitLanguageRequest", "languageInstruction", "localizedLanguage", "foldArabicLetters", "foldRulePatterns"]
      });
    }
  },
  {
    // P2.6 — the output-guard chain. `containsUnconditionalProhibition` now calls
    // `violatesOutputGuards`, so the edge needs the whole dependency closure below
    // it or the edge gate silently loses the ROI, banking, VAT, deposit and
    // cross-customer checks while still looking like it has a claim gate. These
    // five are listed dependency-first purely for readability; each one is mirrored
    // independently and the generator errors on any require it cannot map.
    //
    //   language <- safetyPolicy <- bankingPolicy  ─┐
    //   language <- reservationPolicy              ─┼─> outputGuards
    //   language <- crossCustomerPolicy            ─┘
    file: "safetyPolicy.mjs",
    sources: ["src/safetyPolicy.js"],
    build() {
      return mirrorModule(path.join(REPO, "src", "safetyPolicy.js"), {
        importMap: { "./language": "./language.mjs" }
      });
    }
  },
  {
    file: "bankingPolicy.mjs",
    sources: ["src/bankingPolicy.js"],
    build() {
      return mirrorModule(path.join(REPO, "src", "bankingPolicy.js"), {
        importMap: { "./language": "./language.mjs", "./safetyPolicy": "./safetyPolicy.mjs" }
      });
    }
  },
  {
    file: "reservationPolicy.mjs",
    sources: ["src/reservationPolicy.js"],
    build() {
      return mirrorModule(path.join(REPO, "src", "reservationPolicy.js"), {
        importMap: { "./language": "./language.mjs" }
      });
    }
  },
  {
    file: "crossCustomerPolicy.mjs",
    sources: ["src/crossCustomerPolicy.js"],
    build() {
      return mirrorModule(path.join(REPO, "src", "crossCustomerPolicy.js"), {
        importMap: { "./language": "./language.mjs" }
      });
    }
  },
  {
    // The aggregator refalcoAnswer imports. Mirrored whole so the refusal-clause
    // stripper travels with it: without `withoutRefusalClauses` the edge would
    // flag REFAL's own approved refusals, which is the OG-1 defect this module
    // documents and which already cost a correct Arabic reply once.
    file: "outputGuards.mjs",
    sources: ["src/outputGuards.js"],
    build() {
      return mirrorModule(path.join(REPO, "src", "outputGuards.js"), {
        importMap: {
          "./bankingPolicy": "./bankingPolicy.mjs",
          "./reservationPolicy": "./reservationPolicy.mjs",
          "./crossCustomerPolicy": "./crossCustomerPolicy.mjs"
        }
      });
    }
  },
  {
    // P2.2 — the evidence-aware claim classifier the router below delegates to.
    file: "claimPolicy.mjs",
    sources: ["src/claimPolicy.js"],
    build() {
      return mirrorModule(path.join(REPO, "src", "claimPolicy.js"), {
        importMap: { "./language": "./language.mjs" }
      });
    }
  },
  {
    file: "refalcoAnswer.mjs",
    sources: ["src/refalcoAnswer.js"],
    build() {
      const src = path.join(REPO, "src", "refalcoAnswer.js");
      return [
        BANNER(["src/refalcoAnswer.js"]),
        // DERIVED, not hand-written. These two import lines used to be literals
        // here, and they drifted the moment `src/refalcoAnswer.js` started
        // importing `containsGuaranteeMarker` and `containsPersonalizedConclusion`
        // from claimPolicy: the generator and `--check` both reported success
        // while every edge request threw `containsGuaranteeMarker is not defined`.
        // Only src/mirrorParity.test.js caught it, which is one safety net too
        // few for a customer-reachable gate.
        //
        // Reading the names out of the source makes the failure impossible: a new
        // symbol appears in the mirror automatically, and a require of a module
        // that is NOT mirrored throws here rather than producing a broken file.
        ...derivedImports(src, ["./claimPolicy", "./outputGuards"]),
        "",
        extract(src, "removeSafeDisclaimerClauses"),
        "",
        // The three shared patterns, lifted verbatim. Both the legacy blanket
        // path and the evidence-aware path read these same consts, exactly as
        // src/refalcoAnswer.js does.
        extract(src, "UNSUPPORTED_SUITABILITY"),
        extract(src, "ABSOLUTE_CERTAINTY"),
        extract(src, "BLANKET_RESTRICTED_TOPICS"),
        "",
        // Exported, unlike the other two helpers. src/refalcoAnswer.js exports it
        // too, and src/mirrorParity.test.js needs to assert the OUTPUT-GUARD layer
        // specifically — that REFAL's own refusals are not self-flagged (OG-1).
        // Testing that only through containsProhibitedClaim cannot distinguish a
        // guard hit from a legacy blanket-topic hit.
        extract(src, "containsUnconditionalProhibition").replace(/^function /, "export function "),
        "",
        extract(src, "containsProhibitedClaimLegacy"),
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
