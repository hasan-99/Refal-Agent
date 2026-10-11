const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONSENT_STATES, DIMENSIONS, consentFromText, getConsentState, hasFollowUpPermission,
  hasAutomatedReminderPermission, qualifyLead, recordFollowUpConsent
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
    "Do not send me any more messages",
    "Please stop contacting me",
    "Remove me from your list",
    "لا تراسلني",
    "ما بدي رسائل بعد اليوم",
    "وقفوا التواصل معي",
    "اوقفوا كل الرسائل",
    "بدي معلومات عامة بس، لا تتواصلوا معي.",
    "خلص، لا تتواصلوا معي ولا تبعتوا متابعة.",
    "لو سمحت لا ترتبوا تواصل عني.",
    "لا تبعتوا متابعة.",
    "Μη μου στέλνεις άλλα μηνύματα",
    "Μη μου στέλνετε άλλα μηνύματα",
    "Μην μου στέλνετε ξανά μηνύματα",
    "Δεν θέλω άλλα μηνύματα"
  ]) {
    assert.equal(consentFromText(message), CONSENT_STATES.REVOKED);
  }
  assert.equal(consentFromText("ما بدي حدا يتواصل معي ولا يبعتلي متابعة"), CONSENT_STATES.DENIED);
  assert.equal(consentFromText("لما قلت إي، قصدي إي للمعلومة، مو موافقة حدا يتواصل معي."), CONSENT_STATES.DENIED);
  assert.equal(consentFromText("Please do not pressure me to book or send my contact details. I can ask for that later if I want."), CONSENT_STATES.DENIED);
  assert.equal(consentFromText("Den thelo na me piesis na kleiso rantevou i na doso stoicheia epikoinonias. Tha rotiso argotera an xreiastei."), CONSENT_STATES.DENIED);
});

test("stop requests never become affirmative contact consent", () => {
  for (const message of ["وقفوا التواصل معي", "ما بدي رسائل بعد اليوم", "Μη μου στέλνετε άλλα μηνύματα", "Do not send me any more messages"]) {
    assert.equal(consentFromText(message), CONSENT_STATES.REVOKED, message);
  }
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

test("specialist consent does not authorize automated reminder outreach", () => {
  const user = { id: "x", history: [{
    id: "specialist-turn", at: "2026-10-01T00:00:00Z", source: "whatsapp", message: "Please follow up",
    metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" }, intent: { language: "english" } }
  }] };
  assert.equal(hasFollowUpPermission(user), true);
  assert.equal(hasAutomatedReminderPermission(user), false);
});

test("consent resolution follows source-turn timestamps after history is rehydrated out of order", () => {
  const specialistGrant = {
    id: "grant", at: "2026-10-01T10:00:00Z", message: "Please follow up",
    metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }
  };
  const optOut = { id: "opt-out", at: "2026-10-02T10:00:00Z", message: "Stop messaging me" };
  assert.equal(getConsentState({ user: { id: "x", history: [optOut, specialistGrant] } }), CONSENT_STATES.REVOKED);
  assert.equal(hasFollowUpPermission({ id: "x", history: [optOut, specialistGrant] }), false);

  const reminderGrant = {
    ...specialistGrant,
    metadata: { followUpConsent: { state: "granted", purpose: "automated_reminder", sourceTurnId: "grant", channel: "whatsapp", language: "en" } }
  };
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [optOut, reminderGrant] }), false);
  const renewed = {
    ...reminderGrant, id: "renewed", at: "2026-10-03T10:00:00Z",
    metadata: { followUpConsent: { ...reminderGrant.metadata.followUpConsent, sourceTurnId: "renewed" } }
  };
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [renewed, optOut, reminderGrant] }), true);
});

test("same-time opt-out wins over grants regardless of stored history order", () => {
  const at = "2026-10-01T10:00:00Z";
  const specialistGrant = {
    id: "specialist-grant", at, message: "Please follow up",
    metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } }
  };
  const specialistOptOut = { id: "specialist-opt-out", at, message: "Stop messaging me" };
  for (const history of [[specialistGrant, specialistOptOut], [specialistOptOut, specialistGrant]]) {
    const user = { id: "x", history };
    assert.equal(getConsentState({ user }), CONSENT_STATES.REVOKED);
    assert.equal(hasFollowUpPermission(user), false);
  }

  const reminderGrant = {
    id: "reminder-grant", at, source: "whatsapp", message: "I agree to reminders",
    metadata: { intent: { language: "en" }, followUpConsent: {
      state: "granted", purpose: "automated_reminder", sourceTurnId: "reminder-grant", channel: "whatsapp", language: "en"
    } }
  };
  const reminderOptOut = {
    id: "reminder-opt-out", at, message: "", metadata: { followUpConsent: { state: "revoked", purpose: "automated_reminder" } }
  };
  for (const history of [[reminderGrant, reminderOptOut], [reminderOptOut, reminderGrant]]) {
    assert.equal(hasAutomatedReminderPermission({ id: "x", history }), false);
  }
});

test("untimestamped legacy grants cannot override a timestamped later opt-out", () => {
  const legacyGrant = { id: "legacy-grant", message: "Please follow up",
    metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } };
  const optOut = { id: "opt-out", at: "2026-10-02T10:00:00Z", message: "Stop messaging me" };
  assert.equal(getConsentState({ user: { id: "x", history: [optOut, legacyGrant] } }), CONSENT_STATES.REVOKED);
  assert.equal(hasFollowUpPermission({ id: "x", history: [optOut, legacyGrant] }), false);

  const legacyReminderGrant = { ...legacyGrant, metadata: { followUpConsent: {
    state: "granted", purpose: "automated_reminder", sourceTurnId: "legacy-grant", channel: "whatsapp", language: "en"
  } } };
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [optOut, legacyReminderGrant] }), false);
  const malformedGrant = { ...legacyReminderGrant, id: "malformed-grant", at: "not-a-date",
    metadata: { ...legacyReminderGrant.metadata, followUpConsent: { ...legacyReminderGrant.metadata.followUpConsent, sourceTurnId: "malformed-grant" } } };
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [optOut, malformedGrant] }), false);
});

test("automated reminder consent requires its own durable, scoped, localized source turn", () => {
  const source = {
    id: "reminder-turn", at: "2026-10-01T00:00:00Z", message: "I agree to automated reminders",
    metadata: { intent: { language: "arabic" }, followUpConsent: {
      state: "granted", purpose: "automated_reminder", sourceTurnId: "reminder-turn", channel: "whatsapp", language: "ar"
    } }
  };
  const user = { id: "x", history: [source] };
  assert.equal(hasAutomatedReminderPermission(user), true);
  for (const invalid of [
    { ...source, metadata: { ...source.metadata, followUpConsent: { ...source.metadata.followUpConsent, purpose: "specialist_follow_up" } } },
    { ...source, metadata: { ...source.metadata, followUpConsent: { ...source.metadata.followUpConsent, sourceTurnId: "other-turn" } } },
    { ...source, metadata: { ...source.metadata, followUpConsent: { ...source.metadata.followUpConsent, channel: "" } } },
    { ...source, metadata: { ...source.metadata, intent: { language: "" }, followUpConsent: { ...source.metadata.followUpConsent, language: "" } } },
    { ...source, at: undefined }
  ]) assert.equal(hasAutomatedReminderPermission({ id: "x", history: [invalid] }), false);
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [source, { message: "Stop messaging me" }] }), false);
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [source, { message: "no", metadata: { followUpConsent: { state: "denied", purpose: "automated_reminder" } } }] }), false);
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [source, { message: "", metadata: { followUpConsent: { state: "revoked", purpose: "automated_reminder" } } }] }), false);
  const renewed = { ...source, id: "renewed-turn", at: "2026-10-02T00:00:00Z", metadata: { ...source.metadata, followUpConsent: { ...source.metadata.followUpConsent, sourceTurnId: "renewed-turn" } } };
  // With no timestamp on the opt-out its order relative to the renewal cannot
  // be established, so reminder permission fails closed.
  assert.equal(hasAutomatedReminderPermission({ id: "x", history: [source, { message: "Stop messaging me" }, renewed] }), false);
});

test("future-dated automated reminder consent cannot authorize outreach before its source turn", () => {
  const source = {
    id: "future-reminder-turn", at: "2026-10-02T00:00:00.000Z", message: "I agree to automated reminders",
    metadata: { followUpConsent: {
      state: "granted", purpose: "automated_reminder", sourceTurnId: "future-reminder-turn", channel: "whatsapp", language: "en"
    } }
  };
  const { getAutomatedReminderConsent } = require("./leadQualification");
  assert.equal(getAutomatedReminderConsent({ id: "x", history: [source] }, new Date("2026-10-01T23:54:59.999Z")), null);
  assert.deepEqual(getAutomatedReminderConsent({ id: "x", history: [source] }, new Date("2026-10-02T00:00:00.000Z")), {
    language: "en", channel: "whatsapp", sourceTurnId: "future-reminder-turn"
  });
  assert.equal(getAutomatedReminderConsent({ id: "x", history: [source] }, new Date("invalid")), null);
});
