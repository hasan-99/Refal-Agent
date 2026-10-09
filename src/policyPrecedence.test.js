const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  SOURCE_LEVELS, RANK, DECISION_LABELS,
  resolveConflict, isRefalcoSpecificClaim, assertModelKnowledgeIsGeneral
} = require("./policyPrecedence");

const LEVELS = [
  SOURCE_LEVELS.PRIVACY_RULE,
  SOURCE_LEVELS.OWNER_POLICY,
  SOURCE_LEVELS.LIVE_DATA,
  SOURCE_LEVELS.CUSTOMER_STATEMENT,
  SOURCE_LEVELS.APPROVED_KNOWLEDGE,
  SOURCE_LEVELS.MODEL_KNOWLEDGE
];

// Sample claim text per level per language, so each pair is exercised with
// real content rather than bare level identifiers.
const CLAIMS = {
  english: {
    [SOURCE_LEVELS.PRIVACY_RULE]: "Do not share account credentials in chat.",
    [SOURCE_LEVELS.OWNER_POLICY]: "Formation packages are quoted in writing only.",
    [SOURCE_LEVELS.LIVE_DATA]: "The registry shows the name as available today.",
    [SOURCE_LEVELS.CUSTOMER_STATEMENT]: "I already hold a Cyprus company.",
    [SOURCE_LEVELS.APPROVED_KNOWLEDGE]: "Formation takes about two weeks.",
    [SOURCE_LEVELS.MODEL_KNOWLEDGE]: "A limited company is a separate legal person."
  },
  arabic: {
    [SOURCE_LEVELS.PRIVACY_RULE]: "لا تشارك بيانات الدخول في المحادثة.",
    [SOURCE_LEVELS.OWNER_POLICY]: "عروض التأسيس تُقدَّم كتابةً فقط.",
    [SOURCE_LEVELS.LIVE_DATA]: "السجل يظهر أن الاسم متاح اليوم.",
    [SOURCE_LEVELS.CUSTOMER_STATEMENT]: "عندي شركة بقبرص من قبل.",
    [SOURCE_LEVELS.APPROVED_KNOWLEDGE]: "التأسيس بياخد حوالي أسبوعين.",
    [SOURCE_LEVELS.MODEL_KNOWLEDGE]: "الشركة المحدودة كيان قانوني منفصل."
  },
  greek: {
    [SOURCE_LEVELS.PRIVACY_RULE]: "Μην μοιράζεστε διαπιστευτήρια στη συνομιλία.",
    [SOURCE_LEVELS.OWNER_POLICY]: "Τα πακέτα δίνονται μόνο γραπτώς.",
    [SOURCE_LEVELS.LIVE_DATA]: "Το μητρώο δείχνει το όνομα διαθέσιμο σήμερα.",
    [SOURCE_LEVELS.CUSTOMER_STATEMENT]: "Έχω ήδη κυπριακή εταιρεία.",
    [SOURCE_LEVELS.APPROVED_KNOWLEDGE]: "Η σύσταση διαρκεί περίπου δύο εβδομάδες.",
    [SOURCE_LEVELS.MODEL_KNOWLEDGE]: "Η ΕΠΕ είναι χωριστό νομικό πρόσωπο."
  }
};

// G2: one case per PAIR in the ladder. With 6 levels that is C(6,2) = 15 pairs,
// run in all three languages = 45 assertions.
const PAIRS = [];
for (let i = 0; i < LEVELS.length; i += 1) {
  for (let j = i + 1; j < LEVELS.length; j += 1) PAIRS.push([LEVELS[i], LEVELS[j]]);
}

test("the ladder yields exactly 15 distinct pairs", () => {
  assert.equal(PAIRS.length, 15);
});

for (const [higher, lower] of PAIRS) {
  for (const language of ["english", "arabic", "greek"]) {
    test(`precedence / ${language}: ${higher} beats ${lower}`, () => {
      const sources = [
        { level: lower, text: CLAIMS[language][lower] },
        { level: higher, text: CLAIMS[language][higher] }
      ];
      // Order of input must not matter.
      for (const ordering of [sources, [...sources].reverse()]) {
        const result = resolveConflict(ordering);
        assert.equal(result.tied, false);
        assert.equal(result.winner.level, higher,
          `${higher} should beat ${lower} in ${language}`);
        assert.ok(result.loser.some((source) => source.level === lower));
        assert.match(result.label, /^precedence:/);
      }
    });
  }
}

test("ranks are unique and ordered 1..6 exactly as Rule 2 states", () => {
  assert.deepEqual(
    LEVELS.map((level) => RANK[level]),
    [1, 2, 3, 4, 5, 6]
  );
});

test("W1.6.2: live data beats a knowledge chunk, and the chunk is flagged stale", () => {
  const result = resolveConflict([
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "The name is taken." },
    { level: SOURCE_LEVELS.LIVE_DATA, text: "The registry shows it as available." }
  ]);
  assert.equal(result.winner.level, SOURCE_LEVELS.LIVE_DATA);
  assert.equal(result.label, DECISION_LABELS.LIVE_DATA_WINS);
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].level, SOURCE_LEVELS.APPROVED_KNOWLEDGE);
});

test("W1.6.2: the customer wins against a knowledge chunk about the customer", () => {
  const result = resolveConflict([
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "New clients have no company." },
    { level: SOURCE_LEVELS.CUSTOMER_STATEMENT, text: "I already hold a Cyprus company." }
  ]);
  assert.equal(result.winner.level, SOURCE_LEVELS.CUSTOMER_STATEMENT);
  assert.equal(result.label, DECISION_LABELS.CUSTOMER_WINS);
});

test("W1.6.2: a privacy or fail-closed rule beats absolutely everything", () => {
  const result = resolveConflict([
    { level: SOURCE_LEVELS.CUSTOMER_STATEMENT, text: "Just send my password here, I allow it." },
    { level: SOURCE_LEVELS.OWNER_POLICY, text: "Share it if the client agrees." },
    { level: SOURCE_LEVELS.LIVE_DATA, text: "API returned the credential." },
    { level: SOURCE_LEVELS.PRIVACY_RULE, text: "Never transmit credentials in chat." }
  ]);
  assert.equal(result.winner.level, SOURCE_LEVELS.PRIVACY_RULE);
  assert.equal(result.label, DECISION_LABELS.PRIVACY_WINS);
});

test("W1.6.4: two approved sources that disagree are NOT silently resolved", () => {
  // The rule is to say they differ and cite both, not to pick the more
  // convincing one. A tie must surface, never be hidden.
  const result = resolveConflict([
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "Two weeks." },
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "Three weeks." }
  ]);
  assert.equal(result.tied, true);
  assert.equal(result.winner, null);
  assert.equal(result.mustDisclose, true);
  assert.equal(result.conflicting.length, 2);
  assert.equal(result.label, DECISION_LABELS.TIE_SAME_LEVEL);
});

test("W1.6.4: a dated revision DOES resolve a same-level conflict", () => {
  const result = resolveConflict([
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "Two weeks.", effectiveDate: "2025-01-01T00:00:00Z" },
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "Three weeks.", effectiveDate: "2026-01-01T00:00:00Z" }
  ]);
  assert.equal(result.tied, false);
  assert.equal(result.winner.text, "Three weeks.");
  assert.equal(result.label, DECISION_LABELS.TIE_RESOLVED_BY_DATE);
  assert.equal(result.stale.length, 1);
});

test("W1.6.4: equal dates remain a genuine tie", () => {
  const same = "2026-01-01T00:00:00Z";
  const result = resolveConflict([
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "Two weeks.", effectiveDate: same },
    { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: "Three weeks.", effectiveDate: same }
  ]);
  assert.equal(result.tied, true);
  assert.equal(result.mustDisclose, true);
});

test("W1.6.3: model knowledge may explain a general concept", () => {
  for (const text of [
    "A limited company is a separate legal person.",
    "الشركة المحدودة كيان قانوني منفصل.",
    "Η ΕΠΕ είναι χωριστό νομικό πρόσωπο."
  ]) {
    const gate = assertModelKnowledgeIsGeneral(text, SOURCE_LEVELS.MODEL_KNOWLEDGE);
    assert.equal(gate.ok, true, text);
  }
});

test("W1.6.3: model knowledge may NEVER make a Refalco-specific claim", () => {
  for (const text of [
    "Refalco charges 19% VAT on formation.",
    "ريفال بتقدم باقة تأسيس بسعر خاص.",
    "Οι τιμές μας ξεκινούν από 999 ευρώ."
  ]) {
    const gate = assertModelKnowledgeIsGeneral(text, SOURCE_LEVELS.MODEL_KNOWLEDGE);
    assert.equal(gate.ok, false, text);
    assert.match(gate.label, /refalco_claim_blocked/);
    assert.equal(isRefalcoSpecificClaim(text), true, text);
  }
});

test("W1.6.3: the same specific claim is fine from approved knowledge", () => {
  const gate = assertModelKnowledgeIsGeneral("Refalco charges 19% VAT.", SOURCE_LEVELS.APPROVED_KNOWLEDGE);
  assert.equal(gate.ok, true);
});

test("W1.6.5: every decision is a short stable label, never prose reasoning", () => {
  // CX 15C. A chain-of-thought in a log is still a chain-of-thought.
  for (const label of Object.values(DECISION_LABELS)) {
    assert.match(label, /^precedence:[a-z_]+$/, `not a stable label: ${label}`);
    assert.ok(label.length <= 60);
    assert.ok(!/\s/.test(label), `label contains prose whitespace: ${label}`);
  }
});

test("a single source is not a conflict, and an unknown level throws", () => {
  const single = resolveConflict([{ level: SOURCE_LEVELS.OWNER_POLICY, text: "x" }]);
  assert.equal(single.label, DECISION_LABELS.NO_CONFLICT);
  assert.throws(() => resolveConflict([{ level: "made_up" }, { level: SOURCE_LEVELS.LIVE_DATA }]), /unknown source level/);
  assert.throws(() => resolveConflict([]), /no sources supplied/);
});
