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

const { FALLBACKS: safetyFallbacks } = require("./safetyPolicy");
const { REFUSAL: crossCustomerRefusals } = require("./crossCustomerPolicy");

const REPO = path.join(__dirname, "..");
const EDGE = path.join(REPO, "supabase", "functions", "rafa-agent-api");

function mirror(file) {
  return import(pathToFileURL(path.join(EDGE, file)).href);
}

// A programme fact that is ONLY sayable when approved evidence carries it. It
// names a restricted topic ("residency permit"), so the legacy blanket gate
// deletes it outright; with the matching approved chunk it is a grounded
// PROGRAM_FACT and must be allowed. That asymmetry is the whole point of M2 and
// is exactly what the edge was throwing away by passing no evidence.
const GROUNDED_PROGRAMME_FACT = "The Cyprus residency permit application fee is 500 euro.";
// The same subject turned into a promise. No amount of approved evidence
// rescues a guarantee, so this stays blocked in BOTH modes.
const GUARANTEE_ABOUT_THE_SAME_FACT = "We guarantee the Cyprus residency permit will be issued.";

// --- P2.6 output guards -----------------------------------------------------
//
// `containsUnconditionalProhibition` now delegates to `violatesOutputGuards`,
// which pulls in bankingPolicy, reservationPolicy and crossCustomerPolicy. That
// is five more modules the edge has to carry; if any of them failed to mirror,
// the edge would still EXPORT a claim gate and still return booleans, just a
// weaker set of them. Only running these inputs through both implementations
// catches that.
//
// Each of the three below is chosen because the LEGACY blanket regex does not
// catch it on its own, so a passing verdict here can only come from the new
// guard chain actually being present and wired on both sides.
const ROI_CLAIM = "You can expect a rental yield of 6% per year.";
const CROSS_CUSTOMER_LEAK = "Another client paid 300,000 euro for their residency file.";
// P2.6 finding G-05: before the guards were wired, this was only caught when it
// also happened to trip the blanket topic regex. It does not contain the literal
// "bank approval", so the blanket gate is blind to it.
const BANK_APPROVAL_PROMISE = "The bank will approve your account.";

const OUTPUT_GUARD_CLAIMS = [ROI_CLAIM, CROSS_CUSTOMER_LEAK, BANK_APPROVAL_PROMISE];

// --- REFAL's own refusals ---------------------------------------------------
//
// P2.6 wiring defect OG-1. Switching the guards on made REFAL flag its own
// approved refusals: saying "I cannot provide information about returns"
// contains "returns", and refusing to discuss another client's file necessarily
// names another client's file. The measured cost was real — a correct Arabic
// refusal in src/ragPolicy.test.js was rejected by `validateResponse` and
// replaced with a vaguer fallback. REFAL deleting its own refusal is worse than
// the claim the guard was defending against.
//
// `outputGuards.withoutRefusalClauses` is the fix. These nine strings are the
// exact ones that regressed, so they are pinned here against BOTH
// implementations — a mirror that dropped the stripper would reintroduce OG-1
// on the customer-reachable path only.
const REFAL_OWN_REFUSALS = [
  safetyFallbacks.english.investment,
  safetyFallbacks.arabic.investment,
  safetyFallbacks.greek.investment,
  crossCustomerRefusals.english,
  crossCustomerRefusals.arabic,
  crossCustomerRefusals.greek
];

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
  null,
  // P2.2. The gate is no longer a pure function of the text: with approved
  // evidence in hand it classifies per clause instead of applying the blanket
  // topic ban. So the corpus now has to exercise BOTH branches of the router,
  // and these three pin the interesting edges of it.
  GROUNDED_PROGRAMME_FACT,
  GUARANTEE_ABOUT_THE_SAME_FACT,
  // P2.6. The output-guard chain, and the refusals it must not swallow. Both
  // groups ride the ordinary corpus loop so any src/edge divergence on them is
  // caught by the same mechanism as everything else; the dedicated tests below
  // then pin the absolute verdicts.
  ...OUTPUT_GUARD_CLAIMS,
  ...REFAL_OWN_REFUSALS
];

// --- evidence fixtures ------------------------------------------------------
//
// The shape `isApprovedEvidence` consumes. Only `review_status === "approved"`
// with an unexpired (or absent) `valid_until` counts; everything else is not
// evidence at all and the router falls back to the legacy blanket gate.
const APPROVED_EVIDENCE = Object.freeze([
  Object.freeze({
    review_status: "approved",
    content: "The Cyprus residency permit application fee is 500 euro."
  })
]);

// Same chunk, same text, expired last decade. An expired chunk is NOT evidence,
// so this must behave exactly like passing nothing. If it ever stops doing so,
// a stale approved fact is unlocking claims on a customer-reachable path.
const EXPIRED_EVIDENCE = Object.freeze([
  Object.freeze({
    review_status: "approved",
    valid_until: "2020-01-01T00:00:00.000Z",
    content: "The Cyprus residency permit application fee is 500 euro."
  })
]);

const CLAIM_MODES = [
  ["no evidence", undefined],
  ["approved evidence", { evidence: APPROVED_EVIDENCE }]
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

test("edge refalcoAnswer.mjs returns the SAME verdict as src for every corpus case, in BOTH evidence modes", async () => {
  const { containsProhibitedClaim } = require("./refalcoAnswer");
  const edge = await mirror("refalcoAnswer.mjs");

  // Running the corpus with no evidence only ever exercised the legacy blanket
  // branch. Half the gate — the whole claimPolicy classifier — would have been
  // free to drift undetected. Each mode is a separate code path and each one
  // has to agree across the two implementations.
  const divergent = [];
  for (const [mode, options] of CLAIM_MODES) {
    for (const input of CLAIM_CORPUS) {
      const expected = options ? containsProhibitedClaim(input, options) : containsProhibitedClaim(input);
      const actual = options ? edge.containsProhibitedClaim(input, options) : edge.containsProhibitedClaim(input);
      if (expected !== actual) divergent.push({ mode, input, src: expected, edge: actual });
    }
  }
  assert.deepEqual(divergent, [],
    `the edge claim gate disagrees with src/refalcoAnswer.js — run node scripts/generateEdgeMirrors.js`);
});

test("edge and src agree that approved evidence unlocks a fact and an expired chunk does not", async () => {
  const { containsProhibitedClaim } = require("./refalcoAnswer");
  const edge = await mirror("refalcoAnswer.mjs");

  for (const [label, gate] of [["src", containsProhibitedClaim], ["edge", edge.containsProhibitedClaim]]) {
    // Blocked bare, allowed once the approved chunk carries it.
    assert.equal(gate(GROUNDED_PROGRAMME_FACT), true,
      `${label}: a residency-permit fee with no evidence must stay blocked by the legacy blanket gate`);
    assert.equal(gate(GROUNDED_PROGRAMME_FACT, { evidence: APPROVED_EVIDENCE }), false,
      `${label}: a programme fact quoted from its own approved chunk must be allowed`);

    // An expired chunk is not evidence. Identical text, identical review
    // status, only the date differs — and it must land back on the legacy path.
    assert.equal(gate(GROUNDED_PROGRAMME_FACT, { evidence: EXPIRED_EVIDENCE }), true,
      `${label}: an EXPIRED chunk unlocked a programme fact — stale evidence must never rescue a claim`);

    // Nothing rescues a guarantee.
    assert.equal(gate(GUARANTEE_ABOUT_THE_SAME_FACT), true,
      `${label}: a guarantee must be blocked with no evidence`);
    assert.equal(gate(GUARANTEE_ABOUT_THE_SAME_FACT, { evidence: APPROVED_EVIDENCE }), true,
      `${label}: approved evidence must NOT unlock a guarantee about the same fact`);
  }
});

test("edge and src both block an ROI claim, a cross-customer leak and a bank-approval promise in BOTH modes", async () => {
  const { containsProhibitedClaim } = require("./refalcoAnswer");
  const edge = await mirror("refalcoAnswer.mjs");

  for (const [label, gate] of [["src", containsProhibitedClaim], ["edge", edge.containsProhibitedClaim]]) {
    for (const claim of OUTPUT_GUARD_CLAIMS) {
      assert.equal(gate(claim), true,
        `${label}: "${claim}" must be blocked with no evidence`);
      assert.equal(gate(claim, { evidence: APPROVED_EVIDENCE }), true,
        `${label}: approved evidence must NOT unlock "${claim}" — these are prohibited by what they assert`);
    }
  }
});

test("the output guards are genuinely doing the work — the legacy blanket gate misses two of the three", () => {
  // Without this, the test above could pass on a completely unmirrored edge:
  // if the blanket topic regex already caught all three, the guard chain could
  // be missing entirely and nothing would notice. Pin that it does not.
  const { containsProhibitedClaimLegacy, containsUnconditionalProhibition } = require("./refalcoAnswer");

  assert.equal(containsProhibitedClaimLegacy(ROI_CLAIM), false,
    "the legacy blanket gate now catches the ROI claim — pick a fixture it misses, or this test proves nothing");
  assert.equal(containsProhibitedClaimLegacy(BANK_APPROVAL_PROMISE), false,
    "the legacy blanket gate now catches the bank promise — pick a fixture it misses");

  for (const claim of OUTPUT_GUARD_CLAIMS) {
    assert.equal(containsUnconditionalProhibition(claim), true,
      `the output-guard layer itself must flag "${claim}"`);
  }
});

test("OG-1: REFAL's own refusals are NOT self-flagged by the output guards, in src or on the edge", async () => {
  const { containsUnconditionalProhibition, containsProhibitedClaim } = require("./refalcoAnswer");
  const edge = await mirror("refalcoAnswer.mjs");
  const srcGuards = require("./outputGuards");
  const edgeGuards = await mirror("outputGuards.mjs");

  assert.ok(typeof edge.containsUnconditionalProhibition === "function",
    "the edge mirror stopped exporting containsUnconditionalProhibition — the guard layer can no longer be tested directly");

  const flagged = [];
  for (const refusal of REFAL_OWN_REFUSALS) {
    // The guard layer, both sides. This is the OG-1 regression itself: a mirror
    // that dropped `withoutRefusalClauses` would light up here and nowhere else.
    if (srcGuards.violatesOutputGuards(refusal)) flagged.push({ impl: "src.outputGuards", refusal, reasons: srcGuards.outputGuardViolations(refusal) });
    if (edgeGuards.violatesOutputGuards(refusal)) flagged.push({ impl: "edge.outputGuards", refusal, reasons: edgeGuards.outputGuardViolations(refusal) });
    if (containsUnconditionalProhibition(refusal)) flagged.push({ impl: "src.containsUnconditionalProhibition", refusal });
    if (edge.containsUnconditionalProhibition(refusal)) flagged.push({ impl: "edge.containsUnconditionalProhibition", refusal });
  }
  assert.deepEqual(flagged, [],
    "REFAL's own refusal was flagged as a prohibited claim — OG-1 has regressed and a correct refusal will be deleted on a live reply");

  // And for the cross-customer refusals the WHOLE gate must pass them, in both
  // evidence modes and both implementations. This is the one that actually broke
  // src/ragPolicy.test.js's Arabic case.
  for (const [label, gate] of [["src", containsProhibitedClaim], ["edge", edge.containsProhibitedClaim]]) {
    for (const refusal of [crossCustomerRefusals.english, crossCustomerRefusals.arabic, crossCustomerRefusals.greek]) {
      assert.equal(gate(refusal), false, `${label}: the cross-customer refusal must be allowed with no evidence`);
      assert.equal(gate(refusal, { evidence: APPROVED_EVIDENCE }), false, `${label}: the cross-customer refusal must be allowed with approved evidence`);
    }
  }

  // KNOWN GAP, deliberately not asserted as allowed. The three
  // `safetyPolicy.FALLBACKS[*].investment` strings ARE still blocked by the full
  // gate — but by machinery that predates P2.6, not by the output guards:
  //
  //   english : BLANKET_RESTRICTED_TOPICS matches the literal "investment advice"
  //             (no-evidence mode), and claimPolicy calls it a GUARANTEE
  //             ("guarantee_marker") in the approved-evidence mode;
  //   greek   : claimPolicy, GUARANTEE / guarantee_marker;
  //   arabic  : claimPolicy, PROGRAM_FACT / entities_not_in_evidence.
  //
  // Fixing that means editing src/refalcoAnswer.js or src/claimPolicy.js, which
  // is outside this change. What IS pinned above is that the P2.6 guards are
  // clean on them, so the mirror is not the cause — and the corpus loop pins
  // src and edge to the same verdict either way.
});

test("the mirrored refusal tables carry the same strings as src", async () => {
  // The fixtures above are read from src. If the edge copies of these tables
  // drifted, the edge would be guarding different text than the text it ships.
  const edgeSafety = await mirror("safetyPolicy.mjs");
  const edgeCross = await mirror("crossCustomerPolicy.mjs");

  assert.deepEqual(edgeSafety.FALLBACKS, safetyFallbacks, "safetyPolicy.mjs FALLBACKS drifted from src");
  assert.deepEqual(edgeCross.REFUSAL, crossCustomerRefusals, "crossCustomerPolicy.mjs REFUSAL drifted from src");
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

  for (const [mode, options] of CLAIM_MODES) {
    const claims = CLAIM_CORPUS.map((c) => (options ? containsProhibitedClaim(c, options) : containsProhibitedClaim(c)));
    assert.ok(claims.includes(true), `${mode}: no corpus case is a prohibited claim`);
    assert.ok(claims.includes(false), `${mode}: no corpus case is allowed`);
  }

  // And the two modes must not be the same test run twice: if approved evidence
  // changed no verdict anywhere, the evidence-aware branch is not being reached
  // and the second pass proves nothing.
  const bare = CLAIM_CORPUS.map((c) => containsProhibitedClaim(c));
  const grounded = CLAIM_CORPUS.map((c) => containsProhibitedClaim(c, { evidence: APPROVED_EVIDENCE }));
  assert.ok(bare.some((verdict, index) => verdict !== grounded[index]),
    "approved evidence changed no verdict in the corpus — the evidence-aware branch is never exercised");

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

  // P2.2. The edge has `evidence` in scope where it calls the gate. Calling it
  // bare made this surface strictly MORE restrictive than src — the same class
  // of divergence as a fail-open, just pointing the other way, and equally
  // invisible to a source-text diff.
  assert.match(index, /containsProhibitedClaim\(reply,\s*\{\s*evidence\s*\}\)/,
    "index.ts calls the claim gate without the approved evidence the model was grounded on");
});

test("every committed mirror is byte-identical to what the generators emit", () => {
  for (const script of ["scripts/generateEdgeMirrors.js", "scripts/generateEdgeBrainPrompt.js"]) {
    const result = spawnSync(process.execPath, [script, "--check"], { cwd: REPO, encoding: "utf8" });
    assert.equal(result.status, 0, `${script} --check failed:\n${result.stdout}${result.stderr}`);
  }
});
