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
  assert.equal(qualifyLead({ dimensions: { need: 5, value: 5, timing: 5, authority: 5, readiness: 5, fit: 5 }, thresholds: { hot: 29, warm: 10 } }).status, "hot");
  const result = qualifyLead({ history: [{ message: "We are a family office looking for a strategic partnership." }] });
  assert.equal(result.status, "priority");
  assert.equal(result.priority, true);
  assert.equal(result.priorityReason, "institutional_investment");
});

test("opt-out detection covers English, Arabic, and Greek", () => {
  for (const message of ["Please stop messaging me", "لا تراسلني", "Μη μου στέλνεις άλλα μηνύματα"]) {
    assert.equal(consentFromText(message), CONSENT_STATES.REVOKED);
  }
});

test("follow-up permission requires durable explicit consent and is revocable", () => {
  const user = { id: "x", history: [{ message: "Yes, keep me posted" }] };
  assert.equal(getConsentState({ user }), CONSENT_STATES.GRANTED);
  assert.equal(hasFollowUpPermission(user), true);
  const revoked = recordFollowUpConsent(user, "إلغاء الاشتراك", new Date("2026-10-01T00:00:00Z"));
  assert.equal(getConsentState({ user: revoked }), CONSENT_STATES.REVOKED);
  assert.equal(hasFollowUpPermission(revoked), false);
});
