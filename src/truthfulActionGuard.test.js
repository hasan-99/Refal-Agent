"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { findUnsupportedActionClaims, evaluateTruthfulActions, truthfulActionCorrection } = require("./truthfulActionGuard");
const { runAgentTurn } = require("./agentLoop");
const { buildAgentContext } = require("./agentContext");

const codes = (text, options = {}) => findUnsupportedActionClaims(text, options).findings.map((finding) => finding.code);
const state = (handoff = "not_requested", booking = "none", extra = {}) => ({ actionState: { handoff: { status: handoff }, booking: { status: booking }, ...extra } });

test("F: handoff claims must match the real handoff state", () => {
  const notified = "A specialist has been notified and will reply shortly.";
  assert.deepEqual(codes(notified, state("not_requested")), ["handoff_notified", "response_time"]);
  assert.deepEqual(codes(notified, state("requested")), ["handoff_notified", "response_time"]);
  for (const text of ["Your case was sent to the team.", "Your file is with the team now.", "I have passed this along to our team.", "Your request has been forwarded to our team.",
    "تم إرسال طلبك للفريق.", "ملفك عند الفريق.", "حوّلت طلبك للمختص.", "Το αίτημά σας προωθήθηκε στην ομάδα."]) {
    assert.ok(codes(text, state("requested")).includes("handoff_sent"), text);
    assert.deepEqual(codes(text, state("submitted")), [], `${text} is true once submitted`);
  }
  assert.deepEqual(codes("Someone will reply shortly.", state("submitted")), ["contact_promise", "response_time"], "submitted still has no reply time");
  assert.deepEqual(codes("A specialist has been notified.", state("queued")), ["handoff_notified"], "a queued notification is not a delivered one");
  assert.deepEqual(codes("A specialist has been notified.", state("accepted")), []);
  assert.ok(codes("A human agent has joined the chat.", state("accepted")).includes("human_joined"));
  assert.deepEqual(codes("A human agent has joined the chat.", state("human_joined")), []);
  assert.ok(codes("تم إبلاغ المختص وسيرد عليك قريبا.", state("requested")).includes("handoff_notified"));
  assert.ok(codes("حدا رح يرد عليك خلال ساعة.", state("submitted")).includes("response_time"));
});

test("F: truthful limits, negations and offers are not claims", () => {
  for (const text of ["No specialist has been notified yet.", "Your request is not connected to the team yet.", "I haven't sent your request to the team.",
    "Would you like me to check with the team?", "ما في حدا انبلغ لهلق.", "I can't promise a reply time."]) assert.deepEqual(codes(text, state()), [], text);
});

test("G: booking claims follow the booking workflow state; REFAL's agent can never confirm one itself", () => {
  assert.deepEqual(codes("Your appointment request has been submitted and is pending review.", state("not_requested", "none")), ["booking_submitted"]);
  assert.deepEqual(codes("Your appointment request has been submitted and is pending review.", state("not_requested", "pending_confirmation")), []);
  assert.deepEqual(codes("Your meeting is confirmed for Monday.", state("not_requested", "pending_confirmation")), ["booking_confirmed"]);
  assert.deepEqual(codes("Your meeting is confirmed for Monday.", state("not_requested", "confirmed")), []);
  assert.ok(codes("تم تأكيد موعدك يوم الاثنين.", state("not_requested", "suggested")).includes("booking_confirmed"));
  const failedTool = [{ tool: "requestBookingAction", result: { ok: false, status: "failed" } }];
  assert.deepEqual(codes("Your meeting is confirmed for Monday.", { ...state(), observations: failedTool }), ["booking_confirmed"]);
  const confirmedTool = [{ tool: "requestBookingAction", result: { ok: true, status: "confirmed" } }];
  assert.deepEqual(codes("Your meeting is confirmed for Monday.", { ...state(), observations: confirmedTool }), []);
});

test("H: security, hosting, retention, certification and testing claims need approved evidence on that topic", () => {
  for (const text of ["Your data is encrypted end-to-end.", "We are GDPR compliant.", "Your messages are hosted in the EU.", "We retain data for 30 days.",
    "Each customer's data is isolated.", "We are ISO 27001 certified.", "We run regular penetration tests.", "بياناتك مشفرة بالكامل.", "خوادمنا مستضافة في أوروبا."]) {
    assert.deepEqual(codes(text, state()), ["security_claim"], text);
  }
  const evidence = [{ content: "Customer data is encrypted at rest and hosted in an EU data centre." }];
  assert.deepEqual(codes("Your data is encrypted end-to-end.", { ...state(), evidenceItems: evidence }), []);
  assert.deepEqual(codes("I don't have confirmed details about encryption or hosting.", state()), []);
});

test("I: complaint replies never admit fault or promise a refund/compensation; guarantees are never allowed", () => {
  for (const text of ["It was our fault.", "We take full responsibility for this.", "We will refund you in full.", "You will get a full refund.",
    "الخطأ خطأنا.", "نتحمل كامل المسؤولية.", "رح نرجعلك المصاري.", "سنعوضك عن ذلك."]) assert.deepEqual(codes(text, state()), ["complaint_liability"], text);
  for (const text of ["Approval is guaranteed.", "Your residency will definitely be approved.", "الموافقة مضمونة.", "أكيد رح تنقبل."]) assert.deepEqual(codes(text, state()), ["outcome_guarantee"], text);
  assert.deepEqual(codes("I'm sorry this has been frustrating. We cannot guarantee any outcome.", state()), []);
});

test("K/14: records, tickets and CRM claims need a verified tool success", () => {
  assert.deepEqual(codes("I have saved your details.", state()), ["record_saved"]);
  assert.deepEqual(codes("I have saved your details.", state("not_requested", "none", { leadSaved: true })), []);
  const failedLead = [{ tool: "upsertLead", result: { ok: false, status: "failed", reasonCode: "PERSISTENCE_UNCONFIRMED" } }];
  assert.deepEqual(codes("Your details have been saved.", { ...state(), observations: failedLead }), ["record_saved"]);
  const savedLead = [{ tool: "upsertLead", result: { ok: true, status: "confirmed" } }];
  assert.deepEqual(codes("Your details have been saved.", { ...state(), observations: savedLead }), []);
  for (const text of ["I created a ticket for you.", "Your ticket number is 48213.", "I've saved this in our CRM.", "تم حفظ بياناتك.", "سجلت ملاحظاتك.", "رقم التذكرة 5521."]) {
    assert.ok(codes(text, state("submitted", "none", { leadSaved: true })).includes("ticket_or_crm_claim"), text);
  }
});

test("16: response times need SLA evidence", () => {
  for (const text of ["Our team will reply within one hour.", "We will get back to you today.", "You'll hear back soon.", "نرد عليك خلال ساعة.", "رح يتواصلوا معك اليوم."]) {
    assert.ok(codes(text, state("accepted")).includes("response_time"), text);
  }
  assert.deepEqual(codes("We reply within 2 business days.", { ...state("accepted"), evidenceItems: [{ content: "Support requests receive a reply within 2 business days." }] }), []);
});

test("29: memory mechanics are never exposed", () => {
  for (const text of ["I stored this in my session memory.", "I'll remember you next time.", "حفظت هذا في الذاكرة."]) assert.deepEqual(codes(text, state()), ["memory_mechanics"], text);
  assert.deepEqual(codes("You mentioned earlier that you are based in Cyprus.", state()), []);
});

test("gate form: unsupported sentences are removed when a real answer remains, otherwise rejected", () => {
  const mixed = evaluateTruthfulActions("The package costs 1,950 EUR excluding VAT. A specialist has been notified and will reply shortly.", state());
  assert.equal(mixed.valid, true);
  assert.equal(mixed.text, "The package costs 1,950 EUR excluding VAT.");
  assert.deepEqual(mixed.removed.sort(), ["handoff_notified", "response_time"]);
  const only = evaluateTruthfulActions("Your case was sent to the team.", state());
  assert.equal(only.valid, false);
  assert.deepEqual(only.reasons, ["truthful_action:handoff_sent"]);
  assert.match(truthfulActionCorrection(only.reasons, only.state), /handoff=not_requested/u);
  assert.equal(evaluateTruthfulActions("The package costs 1,950 EUR excluding VAT.", state()).valid, true);
});

test("K: in the agent loop, a failed tool is never reported as success (flag on); flag off keeps today's behaviour", async () => {
  const tools = { upsertLead: { description: "Save lead details.", run: async () => ({ ok: false, status: "failed", reasonCode: "PERSISTENCE_UNCONFIRMED", userSafeSummary: "I couldn't complete that action." }) } };
  const decide = async ({ observations }) => {
    if (!observations.some((item) => item.tool === "upsertLead")) return { type: "tool", tool: "upsertLead", args: { name: "Hassan" } };
    if (observations.some((item) => item?.result?.status === "policy_rejected")) return { type: "respond", text: "I couldn't save your details just now. You can share them again later if you like." };
    return { type: "respond", text: "Your details have been saved, thank you." };
  };
  const base = { currentMessage: "Please save my details, my name is Hassan", locale: "english", contact: { id: "k" } };
  const on = await runAgentTurn(buildAgentContext({ ...base, conversationFeatures: { truthfulActionStates: true }, sessionState: { user: {}, conversation: {}, actions: { handoff: { status: "not_requested" }, booking: { status: "none" } } } }),
    { decideNextStep: decide, tools });
  assert.equal(on.outcome, "responded");
  assert.match(on.response, /couldn't save/u);
  const off = await runAgentTurn(buildAgentContext(base), { decideNextStep: decide, tools });
  assert.match(off.response, /have been saved/u, "documents the gap the flag closes");
});
