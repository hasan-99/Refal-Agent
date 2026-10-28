"use strict";

// Multi-turn WhatsApp conversations through the REAL live turn composition
// (preflight, router, persistence, agent loop, deterministic gates, grounding
// gate) with scripted models and an in-memory store, as in
// latencyFlow.integration.test.js. The model is stubbed: these tests prove
// what code guarantees deterministically (state, prompt content, gates, call
// counts, stored data). Whether a live model follows the customer-context
// block is NOT proven here.

const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentLiveAnswerTurn } = require("./agentLiveAnswerTurn");
const { classifyContextualMessage } = require("./contextualPreflight");
const { buildDecisionMessages } = require("./agentDecision");
const { scriptedGrounding } = require("../scripts/helpers/scriptedGrounding");
const { getSessionMemoryStore } = require("./sessionMemory");
const { evaluateConversations } = require("../scripts/evaluateConversationQuality");

const CONVO_FLAGS = ["RAFA_STRUCTURED_SESSION_MEMORY", "RAFA_USER_PROFILE_MEMORY", "RAFA_ANSWER_FIRST_STYLE", "RAFA_TRUTHFUL_ACTION_STATES", "RAFA_SMART_FOLLOWUPS"];
const LATENCY_FLAGS = ["RAFA_SEARCH_CACHE", "RAFA_SESSION_EVIDENCE_CACHE", "RAFA_FAST_SOCIAL_PATH", "RAFA_FACTUAL_SEARCH_FIRST", "RAFA_RERANK_CACHE"];
const PACKAGE_TEXT = "The company formation package costs 1,950 EUR excluding VAT. It includes company registration, the registered office for the first year and opening the tax file.";
const CONTEXT_HEADER = "Customer context for this conversation";

async function withFlags(on, action) {
  const names = [...CONVO_FLAGS, ...LATENCY_FLAGS];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const name of on) process.env[name] = "on";
  try { return await action(); }
  finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
}

function makeStore({ knowledge = "package", handover = "none", initialUsers = {} } = {}) {
  const users = new Map(Object.entries(initialUsers).map(([id, user]) => [id, structuredClone(user)]));
  const userFor = (id) => { if (!users.has(id)) users.set(id, { id, profile: {}, history: [] }); return users.get(id); };
  let serial = 0;
  const writes = { updateUser: 0, createHandover: 0 };
  return {
    users, writes,
    ensureUser: async (id) => userFor(id),
    getUser: async (id) => userFor(id),
    updateUser: async (id, update) => { writes.updateUser += 1; return update(userFor(id)); },
    addHistory: async (id, message, response, extra) => {
      const turn = { id: `${id}-turn-${++serial}`, at: new Date().toISOString(), message, response, metadata: extra?.metadata || {} };
      userFor(id).history.push(turn);
      return turn;
    },
    updateHistoryTurn: async (id, turnId, patch) => Object.assign(userFor(id).history.find((item) => item.id === turnId), patch),
    saveQualification: async () => {},
    saveIntents: async () => {},
    saveConsent: async () => {},
    ...(handover === "none" ? {} : { createHandover: async () => {
      writes.createHandover += 1;
      if (handover === "fail") throw Object.assign(new Error("handover write failed"), { code: "WRITE_FAILED" });
      return { id: `handover-${writes.createHandover}` };
    } }),
    getKnowledgeVersion: async () => "knowledge-version-1",
    searchKnowledge: async () => knowledge === "package" ? [{ chunk_id: "pkg-1", document_id: "doc-pkg", section_index: "0", chunk_index: 0,
      heading: "Company formation package", document_title: "Refalco Services", content: PACKAGE_TEXT, review_status: "approved", valid_until: null }] : []
  };
}

// preflight: message -> { intents, language, operation }
function scriptedModels({ preflight, decide }) {
  const calls = { preflight: 0, decision: 0, grounding: 0 };
  const prompts = [];
  const contexts = [];
  const classifyMessage = (input, options) => classifyContextualMessage(input, { ...options, callModel: async () => {
    calls.preflight += 1;
    const entry = preflight(input.message) || {};
    return JSON.stringify({ intents: entry.intents || ["general_information"], language: entry.language || "english", operation: entry.operation || "none",
      offerSourceTurnId: null, noProactiveBookingOrContact: false });
  } });
  const decideNextStep = async ({ context, observations, tools, step }) => {
    calls.decision += 1;
    const messages = buildDecisionMessages(context, observations, tools);
    prompts.push(messages);
    contexts.push(context);
    return decide({ context, observations, tools, step, messages });
  };
  const assessDraft = async (args) => { calls.grounding += 1; return scriptedGrounding(args); };
  return { calls, prompts, contexts, classifyMessage, decideNextStep, assessDraft };
}

async function runConversation({ flags = [], messages, userId, store = makeStore(), preflight, decide, beforeTurn }) {
  return withFlags(flags, async () => {
    const models = scriptedModels({ preflight, decide });
    const turns = [];
    for (const [index, text] of messages.entries()) {
      if (beforeTurn) await beforeTurn(index, store);
      const before = { ...models.calls };
      const promptStart = models.prompts.length;
      const logs = [];
      const sent = [];
      await runAgentLiveAnswerTurn({ socket: {}, chatId: "chat", userId, text }, {
        store, embedText: async () => [0.25, 0.5, 0.75],
        logEvent: async (event, fields) => logs.push([event, fields]),
        sendStoredTextReply: async (_s, _c, response) => sent.push(response),
        preflightOptions: { classifyMessage: models.classifyMessage },
        agentOptions: { decideNextStep: models.decideNextStep, assessDraft: models.assessDraft }
      });
      const completed = logs.find(([event]) => event === "agent_turn_completed")?.[1] || {};
      const turnPrompts = models.prompts.slice(promptStart);
      turns.push({ text, reply: sent[0] || null, completed, logs,
        llmCalls: models.calls.preflight + models.calls.decision + models.calls.grounding - before.preflight - before.decision - before.grounding,
        prompts: turnPrompts, firstUserPrompt: turnPrompts[0]?.[1]?.content || "", firstSystemPrompt: turnPrompts[0]?.[0]?.content || "",
        context: models.contexts[promptStart] || null,
        rejections: logs.filter(([event]) => event === "agent_policy_rejected").map(([, fields]) => fields.validationReasons).flat() });
    }
    return turns;
  });
}

const ALL_ON = [...CONVO_FLAGS];
const evidenceIn = (observations) => observations.flatMap((item) => item?.result?.modelObservation?.evidence || []);
const rejectedWith = (observations, prefix) => observations.some((item) => item?.result?.status === "policy_rejected" && String(item.result.reasonCode || "").includes(prefix));

test.beforeEach(() => getSessionMemoryStore().clear());

// ---------------------------------------------------------------- A
test("A: a name correction is applied, kept, and the wrong name never reaches the prompt as the name (English)", async () => {
  const messages = ["Hi, my name is Sami", "My name is not Sami, it is Hassan", "What does the company formation package include?"];
  const preflight = (message) => /package/u.test(message) ? { intents: ["company_formation"] } : { intents: ["greeting"] };
  const decide = ({ context, observations, tools }) => {
    if (evidenceIn(observations).length) return { type: "respond", text: "It includes company registration, the registered office for the first year and opening the tax file." };
    if (/package/u.test(context.currentMessage) && tools.searchApprovedKnowledge) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation package inclusions" } };
    return { type: "respond", text: context.contact?.name ? `Thanks, ${context.contact.name}. How can I help with your business plans today?` : "Hello, I am REFAL. How can I help today?" };
  };
  const off = await runConversation({ messages, userId: "a-off", preflight, decide });
  const on = await runConversation({ flags: ALL_ON, messages, userId: "a-on", preflight, decide });
  // Baseline defect, still present with the flag off: the negated name is captured.
  assert.equal(off[1].context.contact.name, "not Sami");
  assert.equal(on[1].context.contact.name, "Hassan");
  assert.equal(on[2].context.contact.name, "Hassan");
  assert.match(on[1].reply, /Hassan/u);
  assert.doesNotMatch(on[1].reply, /Sami/u);
  assert.match(on[2].firstUserPrompt, /corrected name values \(wrong, never use\): "Sami"/u);
  assert.match(on[2].firstUserPrompt, /Customer-stated name for natural address only[^\n]*: Hassan/u);
});

test("A: Arabic correction (اسمي مش سامي، اسمي حسن) and no name invented from a WhatsApp label", async () => {
  const store = makeStore({ initialUsers: { "a-ar": { id: "a-ar", profile: { whatsappName: "Sami Trading" }, whatsapp: { pushName: "Sami Trading" }, history: [] } } });
  const messages = ["مرحبا", "اسمي مش سامي، اسمي حسن", "شو بتشمل باقة تأسيس الشركة؟"];
  const preflight = (message) => /باقة/u.test(message) ? { intents: ["company_formation"], language: "arabic" } : { intents: ["greeting"], language: "arabic" };
  const decide = ({ context, observations, tools }) => {
    if (evidenceIn(observations).length) return { type: "respond", text: "تشمل الباقة تسجيل الشركة والمكتب المسجل للسنة الأولى وفتح الملف الضريبي." };
    if (/باقة/u.test(context.currentMessage) && tools.searchApprovedKnowledge) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation package inclusions" } };
    return { type: "respond", text: context.contact?.name ? `أهلاً أستاذ ${context.contact.name}، كيف بقدر ساعدك؟` : "أهلاً، أنا REFAL من مجموعة Refalco. كيف بقدر ساعدك؟" };
  };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "a-ar", store, preflight, decide });
  assert.equal(turns[0].context.contact.name, null, "a WhatsApp/profile label is never a name");
  assert.match(turns[0].firstUserPrompt, /name: not given \(never guess one or use a WhatsApp\/profile label\)/u);
  assert.equal(turns[1].context.contact.name, "حسن");
  assert.equal(turns[2].context.contact.name, "حسن");
  assert.match(turns[2].firstUserPrompt, /corrected name values \(wrong, never use\): "سامي"/u);
  assert.doesNotMatch(turns[1].reply, /سامي/u);
});

// ---------------------------------------------------------------- B + J
test("B/J: tentative stays tentative, a downgrade is honoured, and a recap gets Confirmed/Tentative/Open/Corrected lines", async () => {
  const messages = ["We need WhatsApp support for our customers", "We may need Arabic too", "Also we need English", "Actually English was just an idea, not decided", "Can you summarize what we have discussed?"];
  const preflight = () => ({ intents: ["technology"] });
  const decide = () => ({ type: "respond", text: "Understood. I have the main points of your request in view." });
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "b-on", preflight, decide });
  const p1 = turns[1].firstUserPrompt;
  assert.match(p1, /- confirmed: We need WhatsApp support for our customers \[confirmed,user\]/u);
  assert.match(p1, /- tentative \(not decided\): We may need Arabic too \[tentative,user\]/u);
  assert.doesNotMatch(p1, /confirmed: We may need Arabic/u);
  const p3 = turns[3].firstUserPrompt;
  assert.doesNotMatch(p3, /- confirmed: Also we need English/u, "the named requirement is downgraded");
  assert.match(p3, /- confirmed: We need WhatsApp support for our customers/u, "an unrelated confirmed requirement stays confirmed");
  assert.match(p3, /tentative \(not decided\): Also we need English/u);
  assert.match(p3, /corrected: requirement "Also we need English" is no longer confirmed/u);
  const recap = turns[4].firstUserPrompt;
  assert.match(recap, /recap requested: list Confirmed, Tentative, Open and Corrected points separately/u);
  assert.match(recap, /tentative \(not decided\): We may need Arabic too/u);
});

// ---------------------------------------------------------------- C (+ mixed)
test("C: switching Arabic -> English keeps name, country, requirement and topic; the reply language follows the current message", async () => {
  const messages = ["مرحبا، اسمي حسن. احنا في قبرص وبدنا دعم باللغة العربية", "Can we continue in English? How much is the company formation package?"];
  const preflight = (message) => /English/u.test(message) ? { intents: ["pricing", "company_formation"], language: "english" } : { intents: ["greeting", "company_formation"], language: "arabic" };
  const decide = ({ context, observations, tools }) => {
    if (evidenceIn(observations).length) return { type: "respond", text: "The company formation package costs 1,950 EUR excluding VAT." };
    if (/package/u.test(context.currentMessage) && tools.searchApprovedKnowledge) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation package price" } };
    return { type: "respond", text: "أهلاً أستاذ حسن، أنا REFAL من مجموعة Refalco. كيف بقدر ساعدك بتأسيس الشركة؟" };
  };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "c-on", preflight, decide });
  const prompt = turns[1].firstUserPrompt;
  assert.equal(turns[1].context.locale, "english");
  assert.equal(turns[1].context.contact.name, "حسن");
  assert.match(prompt, /country: Cyprus \[confirmed,user\]/u);
  assert.match(prompt, /- confirmed: [^\n]*بدنا دعم باللغة العربية \[confirmed,user\]/u);
  assert.match(prompt, /language: current=english; preferred=english \[confirmed,user\]/u);
  assert.match(turns[1].reply, /1,950 EUR/u);
});

test("C (mixed): an English/Arabic mixed message keeps both the name and the requirement", async () => {
  const messages = ["Hi, اسمي حسن, we need Arabic and English support", "شو بتشمل الباقة؟"];
  const preflight = (message) => /الباقة/u.test(message) ? { intents: ["company_formation"], language: "arabic" } : { intents: ["greeting", "technology"], language: "english" };
  const decide = ({ context }) => ({ type: "respond", text: context.locale === "arabic" ? "تمام، خليني وضحلك شو بتشمل الباقة بالتفصيل حسب المعلومات المعتمدة." : "Hello, I am REFAL from Refalco Group. Happy to help with that." });
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "c-mixed", preflight, decide });
  assert.equal(turns[1].context.contact.name, "حسن");
  assert.match(turns[1].firstUserPrompt, /confirmed: we need Arabic and English support/u);
});

// ---------------------------------------------------------------- D
test("D: a question for a detail already given, and a generic 'anything else?', are stripped without an extra model call", async () => {
  const messages = ["We are based in Cyprus and want to open a company", "What does the company formation package include?"];
  const preflight = (message) => ({ intents: /package/u.test(message) ? ["company_formation"] : ["company_formation"] });
  const decide = ({ context, observations, tools }) => {
    if (evidenceIn(observations).length) return { type: "respond", text: "It includes company registration, the registered office for the first year and opening the tax file. Which country are you based in?" };
    if (/package/u.test(context.currentMessage) && tools.searchApprovedKnowledge) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation package inclusions" } };
    return { type: "respond", text: "Hello, I am REFAL from Refalco Group, and I can help you with company formation. Anything else I can help with?" };
  };
  const off = await runConversation({ messages, userId: "d-off", preflight, decide });
  const on = await runConversation({ flags: ALL_ON, messages, userId: "d-on", preflight, decide });
  assert.match(off[0].reply, /Anything else/u);
  assert.doesNotMatch(on[0].reply, /Anything else/u);
  assert.doesNotMatch(on[1].reply, /Which country/u);
  assert.match(on[1].reply, /registered office/u);
  assert.deepEqual(on.map((t) => t.llmCalls), off.map((t) => t.llmCalls), "stripping costs no model call");
  assert.ok(on[0].completed.cqVagueFollowupsStripped >= 1);
  assert.ok(on[1].completed.cqKnownFieldQuestionsStripped >= 1);
});

// ---------------------------------------------------------------- E
test("E: an unknown price is never invented, and the gap is tracked as an open customer question", async () => {
  const store = makeStore({ knowledge: "none" });
  const messages = ["How much does a bank account opening cost?", "OK, and what about accounting?"];
  const preflight = (message) => ({ intents: /bank/u.test(message) ? ["pricing", "banking"] : ["accounting"] });
  const decide = ({ context, observations, tools }) => {
    const searched = observations.some((item) => item?.tool === "searchApprovedKnowledge");
    if (!searched && tools.searchApprovedKnowledge) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: context.currentMessage } };
    if (observations.some((item) => item?.result?.status === "policy_rejected")) return { type: "respond", text: "I can't confirm that price right now. Would you like me to explain what the service covers instead?" };
    return { type: "respond", text: "Opening a bank account costs 450 EUR." };
  };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "e-on", store, preflight, decide });
  assert.doesNotMatch(turns[0].reply, /\d/u);
  assert.match(turns[1].firstUserPrompt, /open \(unanswered customer question\): pricing, banking/u);
});

// ---------------------------------------------------------------- F
test("F: 'handoff requested' is never reported as notified/sent; with the flag off the false claim gets through", async () => {
  const messages = ["Can a specialist contact me about this?"];
  const preflight = () => ({ intents: ["contact"], operation: "specialist_request" });
  const decide = ({ context, observations }) => {
    if (rejectedWith(observations, "truthful_action")) {
      const status = context.sessionState?.actions?.handoff?.status;
      return { type: "respond", text: status === "submitted"
        ? "Your request is now with the team for review. I can't confirm when they will reply."
        : "I understand you would like a specialist. Your request is not connected to the team yet." };
    }
    return { type: "respond", text: "A specialist has been notified and will reply shortly." };
  };
  const offFail = await runConversation({ messages, userId: "f-off", store: makeStore({ handover: "fail" }), preflight, decide });
  const onFail = await runConversation({ flags: ALL_ON, messages, userId: "f-on-fail", store: makeStore({ handover: "fail" }), preflight, decide });
  const onOk = await runConversation({ flags: ALL_ON, messages, userId: "f-on-ok", store: makeStore({ handover: "ok" }), preflight, decide });
  assert.match(offFail[0].reply, /has been notified/u, "baseline gap: the claim is not caught with the flag off");
  assert.equal(onFail[0].completed.outcome, "responded");
  assert.match(onFail[0].reply, /not connected to the team yet/u);
  assert.match(onOk[0].reply, /with the team for review/u);
  assert.doesNotMatch(onFail[0].reply || "", /notified|reply shortly/u);
  assert.equal(onFail[0].context.sessionState.actions.handoff.status, "requested");
  assert.match(onFail[0].firstUserPrompt, /handoff: requested \(customer asked for it but it is NOT submitted/u);
  assert.equal(onOk[0].context.sessionState.actions.handoff.status, "submitted");
  assert.doesNotMatch(onOk[0].reply || "", /notified|shortly/u);
  assert.ok(onFail[0].rejections.some((reason) => String(reason).startsWith("truthful_action:")));
});

// ---------------------------------------------------------------- G
test("G: no booking claim without the booking workflow's confirmation", async () => {
  const messages = ["Can I meet someone next week?"];
  const preflight = () => ({ intents: ["appointment"] });
  const decide = ({ observations }) => rejectedWith(observations, "truthful_action")
    ? { type: "respond", text: "I can help you request a meeting. The team reviews every request before anything is booked." }
    : { type: "respond", text: "Your appointment request has been submitted and is pending review." };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "g-on", preflight, decide });
  assert.doesNotMatch(turns[0].reply, /request has been submitted|is confirmed|pending review/u);
  assert.ok(turns[0].rejections.includes("truthful_action:booking_submitted"));
  assert.match(turns[0].firstUserPrompt, /booking: none \(none; nothing is booked, reserved or pending\)/u);
});

// ---------------------------------------------------------------- H
test("H: a privacy/security question gets no unsupported hosting/encryption claim", async () => {
  const store = makeStore({ knowledge: "none" });
  const messages = ["Where are my messages stored and are they encrypted?"];
  const preflight = () => ({ intents: ["privacy"] });
  const decide = ({ observations }) => rejectedWith(observations, "truthful_action")
    ? { type: "respond", text: "I don't have confirmed details about hosting or encryption to share here. Would you like me to ask the team for the written details?" }
    : { type: "respond", text: "Your messages are encrypted and hosted securely in the EU." };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "h-on", store, preflight, decide });
  assert.doesNotMatch(turns[0].reply, /encrypted and|hosted securely/u);
  assert.ok(turns[0].rejections.includes("truthful_action:security_claim"));
});

// ---------------------------------------------------------------- I
test("I: a complaint gets empathy without an admission of fault or a refund promise", async () => {
  const messages = ["I'm unhappy, your service was bad and I want my money back"];
  const preflight = () => ({ intents: ["complaint"] });
  const decide = ({ observations }) => rejectedWith(observations, "truthful_action")
    ? { type: "respond", text: "I'm sorry this has been frustrating. I can help you put the concern to the team so they can review it." }
    : { type: "respond", text: "We are very sorry, it was our fault and we will refund you in full." };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "i-on", preflight, decide });
  assert.doesNotMatch(turns[0].reply || "", /our fault|refund you/u);
  assert.ok(turns[0].rejections.includes("truthful_action:complaint_liability"));
});

// ---------------------------------------------------------------- L
test("L: the durable profile keeps only approved fields, seeds a later session, and is deleted on 'forget my details'", async () => {
  const store = makeStore();
  const preflight = () => ({ intents: ["company_formation"] });
  const decide = () => ({ type: "respond", text: "Understood, thank you. Let me know which part of company formation you want to start with." });
  await runConversation({ flags: ALL_ON, messages: ["My name is Hassan. Please reply in English. We may need Arabic later. My budget is 50000 EUR"], userId: "l-on", store, preflight, decide });
  const memoryProfile = store.users.get("l-on").profile.memoryProfile;
  assert.equal(memoryProfile.version, 1);
  assert.deepEqual(Object.keys(memoryProfile.fields).sort(), ["name", "preferredLanguage", "serviceInterest"]);
  assert.equal(memoryProfile.fields.name.value, "Hassan");
  assert.equal(memoryProfile.fields.name.status, "confirmed");
  assert.equal(memoryProfile.fields.serviceInterest[0].status, "inferred");
  assert.doesNotMatch(JSON.stringify(memoryProfile), /Arabic|50000|budget/u, "tentative and sensitive details are never stored");
  // A later session with no transcript (e.g. older turns gone): the profile seeds the name, labelled.
  store.users.get("l-on").history = [];
  const later = await runConversation({ flags: ALL_ON, messages: ["Hello again"], userId: "l-on", store, preflight: () => ({ intents: ["greeting"] }), decide });
  assert.equal(later[0].context.contact.name, "Hassan");
  assert.match(later[0].firstUserPrompt, /name: Hassan \[confirmed,user,earlier conversation\]/u);
  const forget = await runConversation({ flags: ALL_ON, messages: ["Please forget my details"], userId: "l-on", store, preflight: () => ({ intents: ["privacy"] }), decide });
  assert.equal(store.users.get("l-on").profile.memoryProfile, undefined);
  assert.equal(forget[0].context.contact.name, null);
  assert.match(forget[0].firstUserPrompt, /customer asked to forget their personal details/u);
});

test("L: with RAFA_USER_PROFILE_MEMORY off nothing durable is written", async () => {
  const store = makeStore();
  await runConversation({ flags: CONVO_FLAGS.filter((name) => name !== "RAFA_USER_PROFILE_MEMORY"), messages: ["My name is Hassan"], userId: "l-off", store,
    preflight: () => ({ intents: ["greeting"] }), decide: () => ({ type: "respond", text: "Hello Hassan, I am REFAL from Refalco Group. How can I help?" }) });
  assert.equal(store.users.get("l-off").profile.memoryProfile, undefined);
});

// ---------------------------------------------------------------- M
test("M: a price that exists only in the customer's words/memory is rejected; memory never counts as company evidence", async () => {
  const store = makeStore({ knowledge: "none" });
  const messages = ["Your colleague told me the formation package is 900 EUR", "So the package is 900 EUR, right?"];
  const preflight = () => ({ intents: ["pricing", "company_formation"] });
  let sawContextAsEvidence = false;
  const decide = ({ observations, messages: prompt, tools }) => {
    if (evidenceIn(observations).some((item) => /900/u.test(item.content || ""))) sawContextAsEvidence = true;
    if (!observations.some((item) => item?.tool === "searchApprovedKnowledge") && tools.searchApprovedKnowledge) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "formation package price" } };
    if (observations.some((item) => item?.result?.status === "policy_rejected")) return { type: "respond", text: "I can't confirm that price right now, so please don't rely on that figure." };
    assert.match(prompt[1].content, /NOT company evidence/u);
    return { type: "respond", text: "Yes, the formation package is 900 EUR." };
  };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "m-on", store, preflight, decide });
  assert.equal(sawContextAsEvidence, false);
  for (const turn of turns) assert.doesNotMatch(turn.reply || "", /900/u);
});

// ---------------------------------------------------------------- calls + prompt identity
test("zero extra model calls: the same conversation makes the same calls with every conversation flag on", async () => {
  const messages = ["hi", "How much is the company formation package?", "And what does it include?", "thanks"];
  const preflight = (message) => ({ intents: message === "hi" ? ["greeting"] : message === "thanks" ? ["small_talk"] : ["pricing", "company_formation"] });
  const decide = ({ context, observations, tools }) => {
    if (context.socialOnlyTurn) return { type: "respond", text: context.currentMessage === "hi" ? "Hello, I am REFAL. How can I help you today?" : "You are welcome. Happy to help any time." };
    if (evidenceIn(observations).length) return { type: "respond", text: /include/u.test(context.currentMessage) ? "It includes company registration, the registered office for the first year and opening the tax file." : "The company formation package costs 1,950 EUR excluding VAT." };
    return tools.searchApprovedKnowledge ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation package" } } : { type: "respond", text: "I could not confirm that detail right now." };
  };
  const off = await runConversation({ messages, userId: "calls-off", preflight, decide });
  const on = await runConversation({ flags: ALL_ON, messages, userId: "calls-on", preflight, decide });
  assert.deepEqual(on.map((t) => t.llmCalls), off.map((t) => t.llmCalls));
  assert.deepEqual(on.map((t) => t.reply), off.map((t) => t.reply));
  for (const turn of off) {
    assert.ok(!turn.firstUserPrompt.includes(CONTEXT_HEADER));
    assert.equal(turn.completed.cqReplyChars, undefined, "no quality fields with the flags off");
    assert.equal(Object.hasOwn(turn.context, "sessionState"), false);
    assert.equal(Object.hasOwn(turn.context, "conversationFeatures"), false);
  }
  for (const turn of on) {
    assert.ok(turn.firstUserPrompt.includes(CONTEXT_HEADER));
    assert.equal(typeof turn.completed.cqReplyChars, "number");
  }
});

test("quality evaluator: simulated transcripts from this file produce bounded rates", async () => {
  const messages = ["Hi, my name is Sami", "My name is not Sami, it is Hassan", "Can a specialist contact me?"];
  const preflight = (message) => /specialist/u.test(message) ? { intents: ["contact"], operation: "specialist_request" } : { intents: ["greeting"] };
  const decide = ({ context, observations }) => rejectedWith(observations, "truthful_action")
    ? { type: "respond", text: "Your request is not connected to the team yet." }
    : /specialist/u.test(context.currentMessage) ? { type: "respond", text: "A specialist has been notified." }
      : { type: "respond", text: context.contact?.name ? `Thanks ${context.contact.name}, how can I help?` : "Hello, I am REFAL. How can I help?" };
  const turns = await runConversation({ flags: ALL_ON, messages, userId: "eval-on", store: makeStore({ handover: "fail" }), preflight, decide });
  const report = evaluateConversations([{ id: "eval-on", turns: turns.map((turn) => ({ customer: turn.text, reply: turn.reply || "", llmCalls: turn.llmCalls,
    latencyMs: turn.completed.totalDurationMs || 0, handoffState: turn.completed.cqHandoffState, bookingState: turn.completed.cqBookingState,
    correctedNames: turn.context?.sessionState?.user?.nameCorrections?.filter((entry) => entry.reason === "rejected").map((entry) => entry.value) || [] })) }]);
  assert.equal(report.turns, 3);
  assert.equal(report.rates.handoffTruthfulness, 1);
  assert.equal(report.rates.correctionRetention, 1);
  assert.ok(report.averages.llmCallsPerTurn > 0);
});
