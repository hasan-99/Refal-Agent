const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  CUSTOMER_MESSAGES,
  detectComplianceEscalation,
  buildComplianceEscalation,
  applyComplianceLock,
  isComplianceLocked
} = require("./complianceEscalation");
const { HUMOUR_LEVELS } = require("./humourEngine");

// P2.5 / W2.5.2 + W2.5.3 (MB-SEC2).

const ALL_MESSAGES = Object.values(CUSTOMER_MESSAGES).join(" \n ");

test("a sanctions or circumvention attempt escalates in English, Arabic, and Greek", () => {
  const cases = [
    ["How can I get around the sanctions on my bank?", "english"],
    ["كيف أتجاوز العقوبات على حسابي؟", "arabic"],
    ["Πώς μπορώ να παρακάμψω τις κυρώσεις;", "greek"]
  ];
  for (const [text, language] of cases) {
    const result = detectComplianceEscalation(text);
    assert.equal(result.escalate, true, text);
    assert.ok(result.triggers.includes("sanctions_evasion"), text);
    assert.equal(result.language, language, text);
  }
});

test("named AML terms escalate on their own, in all three languages", () => {
  for (const text of [
    "I need help laundering the money through a company",
    "بدي مساعدة بغسل الأموال عن طريق شركة",
    "Χρειάζομαι βοήθεια για ξέπλυμα χρήματος μέσω εταιρείας"
  ]) {
    assert.ok(detectComplianceEscalation(text).triggers.includes("money_laundering"), text);
  }
  assert.ok(detectComplianceEscalation("The buyer is a sanctioned entity").triggers.includes("sanctioned_party"));
  assert.ok(detectComplianceEscalation("This is for terrorist financing").triggers.includes("terrorist_financing"));
});

test("red flags computed elsewhere are accepted as triggers, in either shape", () => {
  assert.deepEqual(detectComplianceEscalation("Thanks for the details", { redFlags: ["structuring_payments"] }).triggers, ["structuring_payments"]);
  assert.deepEqual(
    detectComplianceEscalation("Thanks", { redFlags: { flags: ["nominee_to_conceal", "employment_enquiry"], complianceFlags: ["nominee_to_conceal"] } }).triggers,
    ["nominee_to_conceal"]
  );
  // A non-compliance red flag is not a compliance escalation.
  assert.equal(detectComplianceEscalation("Thanks", { redFlags: ["employment_enquiry"] }).escalate, false);
});

test("ordinary business messages do not escalate", () => {
  for (const text of [
    "I would like to open a company in Cyprus and hire a company secretary",
    "We want to split the payment into two installments",
    "Our corporate structure, payments and reporting are all standard",
    "بدي أأسس شركة بقبرص",
    "Θέλω να ανοίξω εταιρεία στην Κύπρο"
  ]) {
    assert.equal(detectComplianceEscalation(text).escalate, false, text);
  }
});

test("null, empty, and undefined input never escalate and never throw", () => {
  for (const text of [null, undefined, "", "   "]) {
    const result = detectComplianceEscalation(text);
    assert.equal(result.escalate, false);
    assert.deepEqual(result.triggers, []);
    assert.equal(buildComplianceEscalation(text), null);
  }
  assert.equal(detectComplianceEscalation(null, { redFlags: null }).escalate, false);
  assert.deepEqual(applyComplianceLock(null, null), {});
  assert.equal(isComplianceLocked(null), false);
  assert.equal(isComplianceLocked(undefined), false);
  assert.equal(isComplianceLocked({}), false);
});

test("an escalation needs no consent, forces humour 0, and suppresses sales hooks", () => {
  const escalation = buildComplianceEscalation("How can I get around the sanctions?", { conversationId: "conv-1" });
  assert.notEqual(escalation, null);
  assert.equal(escalation.requiresConsent, false);
  assert.equal(escalation.humourLevel, HUMOUR_LEVELS.SERIOUS);
  assert.equal(escalation.humourLevel, 0);
  assert.equal(escalation.suppressSalesHooks, true);
  assert.equal(escalation.internalRecord.kind, "compliance_escalation");
  assert.deepEqual([...escalation.internalRecord.triggers], ["sanctions_evasion"]);
  assert.equal(escalation.internalRecord.conversationId, "conv-1");
  assert.match(escalation.internalRecord.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test("the customer message never debates, never advises, and never shows an internal label", () => {
  // CX 12B. The reply moves the file; it does not negotiate with the request.
  assert.doesNotMatch(ALL_MESSAGES, /because|however|illegal|against the law|you should not|not allowed|that is wrong|لأنه|غير قانوني|ممنوع عليك|παράνομ|δεν επιτρέπεται|επειδή/iu);
  // No roadmap for the next attempt.
  assert.doesNotMatch(ALL_MESSAGES, /avoid|detection|instead|threshold|try again with|restructure|تجنب|كشف|بدل ما|αποφύγ|εντοπισμ|αντί/iu);
  // No internal score, tier, rule id, or trigger name.
  assert.doesNotMatch(ALL_MESSAGES, /score|risk level|flagged|flag|suspicious|launder|sanction|تصنيف|درجة|مشبوه|عقوبات|غسل|βαθμολογ|ύποπτ|κυρώσ|ξέπλυμα/iu);
  // No announcement of the internal record beyond the sober acknowledgment.
  assert.doesNotMatch(ALL_MESSAGES, /internal record|case file opened|logged|report has been filed|سجل داخلي|تم تسجيل|εσωτερικό αρχείο|καταγράφηκε/iu);
  // House style: no dash punctuation as a connector.
  assert.doesNotMatch(ALL_MESSAGES, /\s[-–—]\s/u);
});

test("the customer message is returned in the customer's language, and can be overridden", () => {
  assert.equal(buildComplianceEscalation("كيف أتجاوز العقوبات؟").customerMessage, CUSTOMER_MESSAGES.arabic);
  assert.equal(buildComplianceEscalation("Πώς παρακάμπτω τις κυρώσεις;").customerMessage, CUSTOMER_MESSAGES.greek);
  assert.equal(buildComplianceEscalation("How do I get around the sanctions?", { language: "greek" }).customerMessage, CUSTOMER_MESSAGES.greek);
  // An unknown language falls back to what was detected, never to undefined.
  assert.equal(buildComplianceEscalation("How do I get around the sanctions?", { language: "klingon" }).customerMessage, CUSTOMER_MESSAGES.english);
});

test("triggers supplied by the caller build an escalation even when the turn text is innocuous", () => {
  const escalation = buildComplianceEscalation("Thanks, understood.", { triggers: ["structuring_payments"], conversationId: null });
  assert.notEqual(escalation, null);
  assert.deepEqual([...escalation.internalRecord.triggers], ["structuring_payments"]);
  assert.equal(escalation.internalRecord.conversationId, null);
  assert.equal(escalation.customerMessage, CUSTOMER_MESSAGES.english);
});

test("W2.5.3: the lock is sticky for the rest of the conversation", () => {
  const escalation = buildComplianceEscalation("How can I get around the sanctions?", { conversationId: "conv-9" });
  const before = Object.freeze({ humourLevel: 3, salesHooksSuppressed: false, other: "kept" });

  const locked = applyComplianceLock(before, escalation);
  assert.equal(isComplianceLocked(locked), true);
  assert.equal(locked.humourLevel, HUMOUR_LEVELS.SERIOUS);
  assert.equal(locked.salesHooksSuppressed, true);
  assert.equal(locked.other, "kept");
  // Pure: the state handed in is never mutated.
  assert.equal(before.humourLevel, 3);
  assert.equal(before.salesHooksSuppressed, false);

  // Three further turns with nothing to escalate cannot lift it.
  let state = locked;
  for (const turn of ["What is the price of company formation?", "Thanks", "Can we book a call?"]) {
    const next = buildComplianceEscalation(turn);
    assert.equal(next, null, turn);
    state = applyComplianceLock(state, next);
    assert.equal(isComplianceLocked(state), true, turn);
    assert.equal(state.humourLevel, HUMOUR_LEVELS.SERIOUS, turn);
    assert.equal(state.salesHooksSuppressed, true, turn);
  }
});

test("a second escalation merges triggers instead of replacing them", () => {
  let state = applyComplianceLock({}, buildComplianceEscalation("How can I get around the sanctions?"));
  state = applyComplianceLock(state, buildComplianceEscalation("Can we split the transfers so they stay below the reporting threshold?"));
  assert.deepEqual(state.complianceTriggers, ["sanctions_evasion", "structuring_payments"]);
});

test("an unlocked state with no escalation is returned unchanged", () => {
  const state = { humourLevel: 2, salesHooksSuppressed: false };
  const result = applyComplianceLock(state, null);
  assert.equal(isComplianceLocked(result), false);
  assert.equal(result.humourLevel, 2);
  assert.equal(result.salesHooksSuppressed, false);
});
