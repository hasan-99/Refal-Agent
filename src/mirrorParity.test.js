const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

// Behavioural drift gate for the edge function's ESM mirrors.
//
// The edge function is Deno and cannot require() CommonJS, so every safety
// check it needs exists twice. Until 2026-10-09 the second copy was written by
// hand, and both copies had drifted into FAIL-OPENS on a customer-reachable
// path, with no test touching either one:
//
//   * index.ts's local containsProhibitedClaim predated the guardrail fixes.
//     It passed "We have a 100% success rate", "موافقة مضمونة للجميع" and
//     "Σίγουρη έγκριση για εσάς" — all blocked by src — and it BLOCKED
//     "I cannot provide tax advice", which src deliberately exempts.
//   * responsePolicy.mjs was missing two alternatives of the unconsented
//     contact detector, so "A specialist will contact you shortly" passed.
//
// A source-text comparison cannot catch this: the regexes were legitimately
// different text. Only running both implementations over the same inputs and
// comparing VERDICTS does. That is what this file is.
//
// The corpus deliberately includes the exact strings that were escaping, in
// all three languages, plus the safe-disclaimer cases that must NOT be blocked
// (over-blocking a correct refusal is its own defect, not a safe failure).

const REPO = path.join(__dirname, "..");
const EDGE = path.join(REPO, "supabase", "functions", "rafa-agent-api");

function mirror(file) {
  return import(pathToFileURL(path.join(EDGE, file)).href);
}

// --- prohibited-claim corpus ------------------------------------------------
const CLAIM_CORPUS = [
  // The four that were escaping the edge copy.
  "We have a 100% success rate.",
  "نسبة نجاح 100٪ مضمونة.",
  "موافقة مضمونة للجميع.",
  "Σίγουρη έγκριση για εσάς.",
  // Suitability, which the edge copy had no branch for at all.
  "Your straightforward business activity is suitable and should fit a standard setup.",
  // Safe disclaimers: these must stay ALLOWED. The edge copy blocked the first.
  "I cannot provide tax advice.",
  "I cannot guarantee that bank approval will be granted.",
  "لا أستطيع تقديم استشارة ضريبية.",
  // Ordinary prohibited claims, all three languages.
  "You can expect an investment return of 8% per year.",
  "عائد مضمون على الاستثمار.",
  "εγγυημένη απόδοση επένδυσης.",
  "The company is legally registered in Cyprus.",
  "We will obtain your residency permit.",
  // Ordinary safe answers.
  "Our Limassol office handles corporate formation.",
  "مكتبنا في ليماسول يتولى تأسيس الشركات.",
  "Το γραφείο μας στη Λεμεσό αναλαμβάνει τη σύσταση εταιρειών.",
  "",
  null
];

// --- unconsented-contact corpus --------------------------------------------
const CONTACT_CORPUS = [
  // The three that were escaping the edge copy.
  "A specialist will contact you shortly.",
  "The team will call you tomorrow.",
  "I've asked a specialist to follow up with you.",
  // Must stay blocked.
  "We will contact you next week.",
  "You will be notified once it is ready.",
  "الفريق رح يتواصل معك.",
  "Η ομάδα θα επικοινωνήσει μαζί σας.",
  // Must stay ALLOWED: a capability offer paired with an explicit permission
  // question is consent-seeking, not an unconsented commitment.
  "Would you like me to arrange a call? I can pass this to a specialist.",
  "تحب رتبلك اتصال؟ فيني مرر طلبك للمختص.",
  // Ordinary safe answers.
  "Our Limassol office handles corporate formation.",
  "",
  null
];

test("edge refalcoAnswer.mjs returns the SAME verdict as src for every corpus case", async () => {
  const { containsProhibitedClaim } = require("./refalcoAnswer");
  const edge = await mirror("refalcoAnswer.mjs");

  const divergent = [];
  for (const input of CLAIM_CORPUS) {
    const expected = containsProhibitedClaim(input);
    const actual = edge.containsProhibitedClaim(input);
    if (expected !== actual) divergent.push({ input, src: expected, edge: actual });
  }
  assert.deepEqual(divergent, [],
    `the edge claim gate disagrees with src/refalcoAnswer.js — run node scripts/generateEdgeMirrors.js`);
});

test("edge responsePolicy.mjs returns the SAME verdict as src for every corpus case", async () => {
  const { containsUnconsentedContactCommitment } = require("./responsePolicy");
  const edge = await mirror("responsePolicy.mjs");

  const divergent = [];
  for (const input of CONTACT_CORPUS) {
    const expected = containsUnconsentedContactCommitment(input);
    const actual = edge.containsUnconsentedContactCommitment(input);
    if (expected !== actual) divergent.push({ input, src: expected, edge: actual });
  }
  assert.deepEqual(divergent, [],
    `the edge contact gate disagrees with src/responsePolicy.js — run node scripts/generateEdgeMirrors.js`);
});

test("the corpus actually exercises both verdicts, so agreement is not vacuous", () => {
  // A corpus where every case returns false would pass the two tests above
  // while proving nothing. Pin that both outcomes are represented.
  const { containsProhibitedClaim } = require("./refalcoAnswer");
  const { containsUnconsentedContactCommitment } = require("./responsePolicy");

  const claims = CLAIM_CORPUS.map((c) => containsProhibitedClaim(c));
  assert.ok(claims.includes(true), "no corpus case is a prohibited claim");
  assert.ok(claims.includes(false), "no corpus case is allowed");

  const contacts = CONTACT_CORPUS.map((c) => containsUnconsentedContactCommitment(c));
  assert.ok(contacts.includes(true), "no corpus case is an unconsented commitment");
  assert.ok(contacts.includes(false), "no corpus case is allowed");
});

test("the edge function imports the mirrors instead of keeping its own copy", async () => {
  const fs = require("node:fs");
  const index = fs.readFileSync(path.join(EDGE, "index.ts"), "utf8");

  assert.match(index, /from "\.\/refalcoAnswer\.mjs"/, "index.ts stopped importing the claim-gate mirror");
  assert.match(index, /from "\.\/responsePolicy\.mjs"/, "index.ts stopped importing the contact-gate mirror");
  // The local re-declaration must not come back. This is the specific
  // regression: a `function containsProhibitedClaim` defined IN index.ts.
  assert.doesNotMatch(index, /function\s+containsProhibitedClaim/,
    "index.ts re-declared containsProhibitedClaim locally — that is the drift this mirror exists to end");
  assert.doesNotMatch(index, /function\s+containsUnconsentedContactCommitment/,
    "index.ts re-declared containsUnconsentedContactCommitment locally");
});

test("every committed mirror is byte-identical to what the generators emit", () => {
  for (const script of ["scripts/generateEdgeMirrors.js", "scripts/generateEdgeBrainPrompt.js"]) {
    const result = spawnSync(process.execPath, [script, "--check"], { cwd: REPO, encoding: "utf8" });
    assert.equal(result.status, 0, `${script} --check failed:\n${result.stdout}${result.stderr}`);
  }
});
