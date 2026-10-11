const test = require("node:test");
const assert = require("node:assert/strict");
const { DIMENSIONS, SCORER_VERSION, scoreQualification } = require("./qualificationEngine");

test("scores six evidence-backed dimensions in the 0 to 5 range with source references", () => {
  const result = scoreQualification({ evidence: [
    { sourceRef: "turn:1", text: "I need company formation services." },
    { sourceRef: "turn:2", text: "We have approved funding available." },
    { sourceRef: "turn:3", text: "The deadline is tomorrow." },
    { sourceRef: "turn:4", text: "I am the owner and I can approve this." },
    { sourceRef: "turn:5", text: "I am ready to proceed today." },
    { sourceRef: "turn:6", text: "We have land for development." }
  ], now: "2026-10-10T09:00:00Z" });
  assert.deepEqual(Object.keys(result.dimensions), DIMENSIONS);
  assert.deepEqual(result.dimensions, { need: 2, value: 2, timing: 4, authority: 2, readiness: 1, fit: 2 });
  assert.equal(result.total, 13);
  assert.equal(result.max, 30);
  assert.equal(result.scorerVersion, SCORER_VERSION);
  assert.equal(result.assessedAt, result.scoredAt);
  assert.equal(result.meaningfulEvidenceHash, result.evidenceFingerprint);
  assert.equal(result.sourceTurnId, "turn:1");
  assert.equal(result.scoredAt, "2026-10-10T09:00:00.000Z");
  for (const score of Object.values(result.dimensions)) assert.ok(Number.isInteger(score) && score >= 0 && score <= 5);
  for (const dimension of DIMENSIONS) assert.ok(result.evidenceReferences[dimension].length > 0);
  assert.deepEqual(result.rationale.need, { anchorStrength: 2, evidenceRefs: ["turn:1"] });
});

test("does not accept caller-supplied scores or dimensions as evidence", () => {
  const result = scoreQualification({
    dimensions: { need: 5, value: 5, timing: 5, authority: 5, readiness: 5, fit: 5 },
    profile: { qualification: { dimensions: { authority: 5, readiness: 5 } } },
    evidence: [{ sourceRef: "turn:1", text: "Hello, what is your name?" }]
  });
  assert.deepEqual(result.dimensions, { need: 0, value: 0, timing: 0, authority: 0, readiness: 0, fit: 0 });
  assert.equal(result.total, 0);
});

test("nationality, name, or language statements alone do not infer protected dimensions", () => {
  const result = scoreQualification({ evidence: [
    { sourceRef: "turn:1", text: "My name is Sami and I am from Jordan." },
    { sourceRef: "turn:2", text: "I speak Arabic and my nationality is Greek." },
    { sourceRef: "turn:3", text: "اسمي أحمد وأنا من لبنان وأتحدث العربية." },
    { sourceRef: "turn:4", text: "Ονομάζομαι Νίκος και είμαι από την Κύπρο." }
  ] });
  assert.equal(result.total, 0);
  assert.equal(result.dimensions.authority, 0);
  assert.equal(result.dimensions.readiness, 0);
  assert.deepEqual(result.evidenceReferences.authority, []);
  assert.deepEqual(result.evidenceReferences.readiness, []);
});

test("requires attributable, meaningful evidence and deduplicates repeated references", () => {
  const result = scoreQualification({ evidence: [
    { text: "I am the owner" },
    { sourceRef: "turn:1", text: "ok" },
    { sourceRef: "turn:2", text: "I am the owner" },
    { sourceRef: "turn:2", text: "I am the owner" }
  ] });
  assert.equal(result.dimensions.authority, 1);
  assert.deepEqual(result.evidenceReferences.authority, ["turn:2"]);
});

test("anchor strength follows evidence specificity rather than repeated caller labels", () => {
  const repeated = scoreQualification({ evidence: Array.from({ length: 6 }, (_, index) => ({
    sourceRef: `turn:${index + 1}`,
    text: "I am looking for company formation services."
  })) });
  const strong = scoreQualification({ evidence: [{ sourceRef: "turn:strong", text: "I cannot proceed without company formation." }] });
  assert.equal(repeated.dimensions.need, 2);
  assert.equal(repeated.evidenceRefs.need.length, 6);
  assert.equal(strong.dimensions.need, 5);
  assert.deepEqual(strong.rationale.need, { anchorStrength: 5, evidenceRefs: ["turn:strong"] });
});

test("trait phrases cannot smuggle anchor words into qualification", () => {
  for (const text of [
    "My name is Budget.",
    "My name is Ready to Proceed.",
    "My nationality is Director.",
    "اسمي ميزانية.",
    "Ονομάζομαι Ready to Proceed."
  ]) {
    const result = scoreQualification({ evidence: [{ sourceRef: "unverified-caller-ref", text }] });
    assert.equal(result.total, 0, text);
  }
});

test("trait clauses do not erase independent readiness or authority evidence", () => {
  const arabic = scoreQualification({ evidence: [{ sourceRef: "turn:trait-ready", text: "I speak Arabic, and I am ready to proceed." }] });
  const greek = scoreQualification({ evidence: [{ sourceRef: "turn:trait-authority", text: "My language is Greek, and I own a company." }] });
  assert.ok(arabic.dimensions.readiness > 0);
  assert.ok(greek.dimensions.authority > 0);
});

test("trait clauses preserve independent assertions joined with and or but", () => {
  const funding = scoreQualification({ evidence: [{ sourceRef: "turn:trait-funding", text: "I speak Arabic but we have secured funding." }] });
  const need = scoreQualification({ evidence: [{ sourceRef: "turn:trait-need", text: "My name is Budget and I need company formation." }] });
  assert.ok(funding.dimensions.value > 0);
  assert.ok(need.dimensions.need > 0);
});

test("negated need, authority, value, and readiness do not increase scores", () => {
  const result = scoreQualification({ evidence: [
    { sourceRef: "turn:1", text: "I am not ready to proceed." },
    { sourceRef: "turn:2", text: "I do not need company formation." },
    { sourceRef: "turn:3", text: "I have no budget for investment." },
    { sourceRef: "turn:4", text: "I am not the owner and cannot approve." }
  ] });
  assert.equal(result.dimensions.readiness, 0);
  assert.equal(result.dimensions.need, 0);
  assert.equal(result.dimensions.value, 0);
  assert.equal(result.dimensions.authority, 0);
});

test("affirmative evidence after English, Arabic, and Greek contrast boundaries is still scored", () => {
  const cases = [
    ["I am not ready now, but I want to start the process.", "readiness"],
    ["I do not need company formation, but I need help with company services.", "need"],
    ["I have no budget today, but we have secured funding.", "value"],
    ["I am not the owner, but I can approve the budget.", "authority"],
    ["لا أحتاج تأسيس شركة، لكن أحتاج مساعدة في خدمات الشركات", "need"],
    ["لست جاهزًا الآن، لكن أريد أن أبدأ العملية", "readiness"],
    ["Δεν είμαι έτοιμος τώρα, αλλά θέλω να ξεκινήσω τη διαδικασία", "readiness"],
    ["Δεν χρειάζομαι ίδρυση εταιρείας, αλλά χρειάζομαι υπηρεσίες εταιρείας", "need"]
  ];
  for (const [text, dimension] of cases) {
    const result = scoreQualification({ evidence: [{ sourceRef: "turn:mixed", text }] });
    assert.ok(result.dimensions[dimension] > 0, `${dimension}: ${text}`);
    assert.deepEqual(result.evidenceReferences[dimension], ["turn:mixed"]);
  }
});

test("source turn and rationale stay deterministic when equivalent evidence is reordered", () => {
  const evidence = [
    { sourceRef: "turn:20", text: "I am the owner." },
    { sourceRef: "turn:10", text: "I can approve the budget." },
    { sourceRef: "turn:30", text: "I need company formation." }
  ];
  const first = scoreQualification({ evidence, now: "2026-10-10T09:00:00Z" });
  const reordered = scoreQualification({ evidence: [...evidence].reverse(), now: "2026-10-10T09:00:00Z" });
  assert.equal(first.meaningfulEvidenceHash, reordered.meaningfulEvidenceHash);
  assert.equal(first.sourceTurnId, reordered.sourceTurnId);
  assert.deepEqual(first.dimensions, reordered.dimensions);
  assert.deepEqual(first.rationale, reordered.rationale);
});

test("returns prior score without recomputing unless meaningful evidence changes", () => {
  const first = scoreQualification({ evidence: [{ sourceRef: "turn:1", text: "I need company formation." }], now: "2026-10-10T09:00:00Z" });
  const same = scoreQualification({ evidence: [
    { sourceRef: "turn:1", text: "I need company formation." },
    { sourceRef: "turn:1", text: "I need company formation." },
    { sourceRef: "turn:2", text: "Hello, how are you?" }
  ], previous: first, now: "2026-10-11T09:00:00Z" });
  assert.equal(same.recomputed, false);
  assert.equal(same.scoredAt, first.scoredAt);
  assert.deepEqual(same.dimensions, first.dimensions);

  const changed = scoreQualification({ evidence: [
    { sourceRef: "turn:1", text: "I need company formation." },
    { sourceRef: "turn:3", text: "The deadline is tomorrow." }
  ], previous: first, now: "2026-10-11T09:00:00Z" });
  assert.equal(changed.recomputed, true);
  assert.notEqual(changed.evidenceFingerprint, first.evidenceFingerprint);
  assert.equal(changed.scoredAt, "2026-10-11T09:00:00.000Z");
  assert.ok(changed.total > first.total);
});
