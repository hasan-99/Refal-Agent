const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONSENT_STATES, DIMENSIONS, consentFromText, getConsentState, hasFollowUpPermission,
  qualifyLead, recordFollowUpConsent
} = require("./leadQualification");

test("qualification always returns six bounded dimensions and a 0..30 total", () => {
  const result = qualifyLead({ history: [{ message: "I need a large development meeting urgently; I am the owner." }] });
  assert.deepEqual(Object.keys(result.dimensions), DIMENSIONS);
  assert.ok(result.total >= 0 && result.total <= 30);
  for (const score of Object.values(result.dimensions)) assert.ok(Number.isInteger(score) && score >= 0 && score <= 5);
  assert.equal(result.max, 30);
});

test("owner thresholds and contextual priority are explicit", () => {
  assert.equal(qualifyLead({ dimensions: { need: 5, value: 5, timing: 5, authority: 5, readiness: 5, fit: 4 }, thresholds: { hot: 29, warm: 10, strategic: 30 } }).status, "hot");
  const result = qualifyLead({ history: [{ message: "We are a family office looking for a strategic partnership." }] });
  assert.equal(result.status, "priority");
  assert.equal(result.priority, true);
  assert.equal(result.priorityReason, "institutional_investment");
});

test("company mentions do not imply decision authority or preserve stale inferred scores", () => {
  const result = qualifyLead({
    history: [{ message: "I want to register an investment company in Cyprus" }],
    profile: { leadQualification: { dimensions: { authority: 5, readiness: 5 } } }
  });
  assert.equal(result.dimensions.authority, 0);
  assert.equal(result.dimensions.readiness, 0);
});

test("opt-out detection covers English, Arabic, and Greek", () => {
  for (const message of [
    "Please stop messaging me",
    "لا تراسلني",
    "بدي معلومات عامة بس، لا تتواصلوا معي.",
    "خلص، لا تتواصلوا معي ولا تبعتوا متابعة.",
    "لو سمحت لا ترتبوا تواصل عني.",
    "لا تبعتوا متابعة.",
    "Μη μου στέλνεις άλλα μηνύματα"
  ]) {
    assert.equal(consentFromText(message), CONSENT_STATES.REVOKED);
  }
  assert.equal(consentFromText("ما بدي حدا يتواصل معي ولا يبعتلي متابعة"), CONSENT_STATES.DENIED);
  assert.equal(consentFromText("لما قلت إي، قصدي إي للمعلومة، مو موافقة حدا يتواصل معي."), CONSENT_STATES.DENIED);
  assert.equal(consentFromText("Please do not pressure me to book or send my contact details. I can ask for that later if I want."), CONSENT_STATES.DENIED);
  assert.equal(consentFromText("Den thelo na me piesis na kleiso rantevou i na doso stoicheia epikoinonias. Tha rotiso argotera an xreiastei."), CONSENT_STATES.DENIED);
});

test("follow-up permission requires purpose-bound consent and is revocable", () => {
  const user = { id: "x", history: [{ message: "Yes, keep me posted" }] };
  assert.equal(getConsentState({ user }), CONSENT_STATES.UNKNOWN);
  assert.equal(hasFollowUpPermission(user), false);
  user.history.push({ message: "Please follow up", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } });
  assert.equal(getConsentState({ user }), CONSENT_STATES.GRANTED);
  assert.equal(hasFollowUpPermission(user), true);
  const revoked = recordFollowUpConsent(user, "إلغاء الاشتراك", new Date("2026-10-01T00:00:00Z"));
  assert.equal(getConsentState({ user: revoked }), CONSENT_STATES.REVOKED);
  assert.equal(hasFollowUpPermission(revoked), false);
});

test("direct specialist follow-up phrasing is recognized as an explicit opt-in", () => {
  assert.equal(consentFromText("Please have a specialist follow up."), CONSENT_STATES.GRANTED);
  assert.equal(consentFromText("Please connect me to someone if the bot can't inspect the attachment."), CONSENT_STATES.GRANTED);
});

test("bare booking confirmations and unrelated yes replies never grant follow-up consent", () => {
  const user = { id: "x", history: [{ message: "yes" }, { message: "Yes, confirm the booking" }] };
  assert.equal(getConsentState({ user }), CONSENT_STATES.UNKNOWN);
  assert.equal(hasFollowUpPermission(user), false);
});
