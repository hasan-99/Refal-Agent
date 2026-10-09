const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// ---------------------------------------------------------------------------
// Repo-wide guard for the ASCII word-boundary bug.
//
// JavaScript's \b is defined on [A-Za-z0-9_] and stays ASCII-only even under
// the /u flag. Arabic, Greek and emoji characters are not \w, so a \b placed
// next to one can NEVER match and the whole alternative becomes dead code that
// fails silently.
//
// This is not theoretical. On 2026-10-09 a single sweep found it live in:
//   * responsePolicy.js  — the Arabic/Greek guarantee detector matched nothing,
//                          and the "100%" absolute-claim detector matched
//                          nothing in ANY language
//   * refalcoAnswer.js   — "999 يورو" did not register as a price claim while
//                          "999 EUR" did
//   * followUp.js        — the known unreachable Arabic goodbye branch
//
// Every one of those fails OPEN on a customer-facing safety check, which is why
// this guard exists rather than a code-review convention. It is a lint, so it is
// intentionally conservative: it flags the shapes that are almost always wrong
// and carries an explicit allowlist for reviewed exceptions.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname);
const REPO = path.join(__dirname, "..");

// Deliberately NOT "any non-ASCII character". Typographic punctuation such as
// the curly apostrophe ’ (U+2019) is non-ASCII but harmless next to \b, and
// including it produced false positives on every `(?:'|’)` contraction group.
// What actually breaks is a non-ASCII LETTER or an emoji, because those are the
// things a pattern needs to match and that \b makes unreachable.
const NON_ASCII = "[\\u0600-\\u06FF\\u0750-\\u077F\\u0370-\\u03FF\\u1F00-\\u1FFF"
  + "\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]";

// The four shapes that make a non-ASCII alternative unreachable.
const PROBES = [
  { name: "\\b immediately before a non-ASCII character", re: new RegExp(`\\\\b${NON_ASCII}`, "u") },
  { name: "non-ASCII character immediately before \\b", re: new RegExp(`${NON_ASCII}\\\\b`, "u") },
  { name: "\\b(?: opening on a non-ASCII alternative", re: new RegExp(`\\\\b\\(\\?:${NON_ASCII}`, "u") },
  { name: "non-ASCII alternative closed by )\\b", re: new RegExp(`${NON_ASCII}\\)\\\\b`, "u") }
];

// Reviewed exceptions, each with the reason it is safe. Keyed "file:line".
// Keep this list SHORT; an entry here is a claim that the dead branch does not
// matter, which is rarely true for a customer-facing check.
const ALLOWED = new Map([]);

// Scope widened at the M1 close. The original version did a non-recursive
// readdirSync over src/ filtered to .js, so it never saw dashboard/, scripts/,
// supabase/functions/, any .mjs or .ts, or any subdirectory. Every one of those
// blind spots turned out to contain a real instance: the edge function's
// responsePolicy.mjs had two dead Arabic/Greek permission branches that the
// CommonJS original had already fixed.
const ROOTS = ["src", "dashboard", "scripts", path.join("supabase", "functions")];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(?:js|mjs|ts)$/.test(entry.name)) continue;
      if (/\.test\.(?:js|mjs|ts)$/.test(entry.name)) continue;
      found.push(path.relative(REPO, path.join(dir, entry.name)));
    }
  };
  for (const root of ROOTS) {
    const dir = path.join(REPO, root);
    if (fs.existsSync(dir)) walk(dir);
  }
  return found.sort();
}

test("no regex in src/ places \\b next to a non-ASCII character", () => {
  const findings = [];

  for (const file of sourceFiles()) {
    const lines = fs.readFileSync(path.join(REPO, file), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trimStart();
      // Comments explain the bug; they must not trip the guard that detects it.
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

      const location = `${file}:${index + 1}`;
      if (ALLOWED.has(location)) return;

      for (const probe of PROBES) {
        if (probe.re.test(line)) {
          findings.push(`${location} — ${probe.name}`);
          return;
        }
      }
    });
  }

  assert.deepEqual(findings, [],
    `\\b is ASCII-only in JavaScript, so these non-ASCII alternatives are unreachable dead code:\n  ${findings.join("\n  ")}\n`
    + "Split the pattern into a Latin half (which may keep \\b) and a non-Latin half (which must not), "
    + "or use an explicit lookaround such as (?=\\s|$).");
});

test("the guard actually detects the shapes it claims to", () => {
  // A lint that cannot fail is worse than no lint. These are the real-world
  // shapes that shipped, asserted against the probes directly.
  const bad = [
    String.raw`/\b(?:guarante|garanti|مضمون|ضمان)\b/i`,
    String.raw`/\b(?:EUR|يورو|دولار)\b/iu`,
    String.raw`/^(?:και|ή)\b/iu`,
    String.raw`/\bالإقامة/u`
  ];
  for (const sample of bad) {
    assert.ok(PROBES.some((probe) => probe.re.test(sample)), `guard missed a known-bad pattern: ${sample}`);
  }

  // And must not fire on correct code.
  const good = [
    String.raw`/\b(?:guarantee|guaranteed)\b/i`,
    String.raw`/(?:مضمون|ضمان|εγγυώμαι)/iu`,
    String.raw`/^(?:και|ή)(?=\s|$)/iu`,
    String.raw`/\bvat\b/iu`
  ];
  for (const sample of good) {
    assert.ok(!PROBES.some((probe) => probe.re.test(sample)), `guard false-positived on: ${sample}`);
  }
});

test("the known fail-opens found on 2026-10-09 stay fixed", () => {
  // Regression locks on the specific defects, independent of the lint above.
  const { containsProhibitedClaim } = require("./refalcoAnswer");
  const { validateResponse } = require("./responsePolicy");

  // Arabic and Greek guarantee language must be caught, not just English.
  for (const claim of ["موافقة مضمونة للجميع.", "Σίγουρη έγκριση για εσάς."]) {
    const result = validateResponse(claim, { minSentences: 0, maxSentences: 5, maxChars: 700 });
    assert.ok(result.reasons.includes("prohibited_claim"), `guarantee claim not blocked: ${claim}`);
  }

  // The absolute-certainty claim must be blocked — it previously never was,
  // in any language.
  for (const claim of ["We have a 100% success rate.", "نسبة نجاح 100٪ مضمونة."]) {
    const result = validateResponse(claim, { minSentences: 0, maxSentences: 5, maxChars: 700 });
    assert.ok(result.reasons.includes("prohibited_claim"), `absolute claim not blocked: ${claim}`);
  }

  // But NOT a blanket ban on "100%". This is a correct, useful fact and
  // blocking it would push REFAL into vagueness about ownership.
  assert.equal(containsProhibitedClaim("A non-resident can own 100% of a Cyprus company."), false,
    "legitimate 100% ownership fact must not be blocked");
});
