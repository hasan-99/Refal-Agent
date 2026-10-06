// REFAL-AGENT-015 — End-to-end Agent scenario matrix.
//
// Shared by src/agentScenarios.test.js (asserts) and
// scripts/generateScenarioMatrixReport.js (writes
// docs/refal-agent-scenario-matrix.md) so the matrix definition and the
// report are never two separate sources of truth.
//
// Each scenario runs through the REAL Agent-runtime boundary
// (runAgentTurnForContact, or runAgentTurn + the real TOOL_REGISTRY for
// booking scenarios that need an explicit deterministic `now`) with a
// SCRIPTED decision sequence standing in for the model. This proves the
// deterministic context/tool/policy chain behaves correctly for a given
// decision sequence — it does not (and cannot, without a real model) prove
// that a real model would choose that sequence. That distinction is called
// out per-scenario where it matters; Ticket 016's benchmark is what measures
// real-model decision quality against this same scaffolding.
//
// Side-effect safety: every scenario uses an in-memory fake store and, for
// booking scenarios, a mocked googleapis `calendar()` — nothing here can
// reach a real customer, a real Google Calendar, or real Supabase data.

const { runAgentTurn } = require("./agentLoop");
const { runAgentTurnForContact } = require("./agentRuntime");
const { TOOL_REGISTRY } = require("./agentTools");
const { __resetBookingToolState } = require("./agentBookingTools");
const { summarizeAgentTurn, languageSignalsFrom } = require("./agentObservability");
const { detectMessageLanguage } = require("./language");
const { detectIntent } = require("./intent");
const { google } = require("googleapis");

// --- shared helpers ----------------------------------------------------------

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

function observe(result, locale) {
  return { result, telemetry: summarizeAgentTurn(result), locale };
}

async function runInfo({ message, locale, decisions, extra = {}, maxSteps }) {
  const result = await runAgentTurnForContact(
    { currentMessage: message, locale, user: { id: "u1" }, userId: "u1", embedText: async () => null, ...extra },
    { decideNextStep: scriptedDecider(decisions), maxSteps }
  );
  return observe(result, locale);
}

async function runWithTools({ message, locale, decisions, toolContext, maxSteps = 4 }) {
  const result = await runAgentTurn(
    { currentMessage: message, locale },
    { decideNextStep: scriptedDecider(decisions), tools: TOOL_REGISTRY, toolContext, maxSteps }
  );
  return observe(result, locale);
}

const BOOKING_POLICY = Object.freeze({
  timezone: "Europe/Nicosia", calendarId: "primary", weekdays: [1, 2, 3, 4, 5],
  startTime: "08:30", endTime: "11:00", durationMinutes: 30, durationOwnerConfirmed: true,
  minimumNoticeHours: 24, reminderHours: [12], createMeetLink: true
});
const BOOKING_NOW = new Date("2026-10-01T06:00:00.000Z");
const SLOT = { start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T07:30:00.000Z" };
const SLOT_2 = { start: "2026-10-06T07:00:00.000Z", end: "2026-10-06T07:30:00.000Z" };

// Sets env + google.calendar mock for the duration of `fn`, then restores —
// self-contained so it works both under node:test and the plain report
// script (no reliance on node:test's TestContext).
async function withCalendarEnv({ busy = [], insertResult } = {}, fn) {
  const keys = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN", "GOOGLE_CALENDAR_CLIENT_EMAIL", "GOOGLE_CALENDAR_PRIVATE_KEY"];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = `test-${key.toLowerCase()}`;
  const originalCalendar = google.calendar;
  const calls = { insert: 0, freebusy: 0 };
  google.calendar = () => ({
    freebusy: { query: async () => { calls.freebusy += 1; return { data: { calendars: { primary: { busy } } } }; } },
    events: {
      insert: async (params) => {
        calls.insert += 1;
        if (insertResult) return insertResult(params);
        return { data: { ...params.requestBody, id: params.requestBody.id, htmlLink: "https://calendar.google.com/calendar/event?id=test", hangoutLink: "https://meet.google.com/abc-defg-hij" } };
      }
    }
  });
  __resetBookingToolState();
  try {
    return await fn(calls);
  } finally {
    google.calendar = originalCalendar;
    __resetBookingToolState();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeBookingUser(id = "35799111222@c.us") {
  return { id, phone: "35799111222", profile: { name: "Test" }, booking: null };
}

function confirmingStore(overrides = {}) {
  const persisted = { id: "11111111-1111-4111-8111-111111111111", status: "confirmed", google_event_id: "evt-1" };
  return {
    getBookingPolicy: async () => BOOKING_POLICY,
    createAppointment: async () => ({ appointment: persisted }),
    updateAppointment: async (id, patch) => Object.assign(persisted, patch),
    ...overrides
  };
}

function bookingToolContext(store, extra = {}) {
  const user = makeBookingUser();
  return { store, user, userId: user.id, policy: BOOKING_POLICY, now: BOOKING_NOW, inboundMessageId: "wa-msg-1", language: "english", ...extra };
}

// --- generic expectation evaluator -------------------------------------------
// One declarative schema covers the common properties every scenario family
// needs (outcome, tool usage, question count, fallback, language mismatch);
// `custom` is the escape hatch for side-effect/state assertions a flat schema
// can't express cleanly (store call counts, appointment status, etc.).
function evaluateScenario(expected, observed) {
  const failures = [];
  const { result, telemetry, locale } = observed;
  if (expected.outcome && result.outcome !== expected.outcome) {
    failures.push(`outcome: expected "${expected.outcome}", got "${result.outcome}"`);
  }
  if (expected.outcomeIn && !expected.outcomeIn.includes(result.outcome)) {
    failures.push(`outcome: expected one of [${expected.outcomeIn.join(", ")}], got "${result.outcome}"`);
  }
  for (const tool of expected.toolsInclude || []) {
    if (!result.toolsUsed.includes(tool)) failures.push(`expected tool "${tool}" to be used; toolsUsed=[${result.toolsUsed.join(", ")}]`);
  }
  for (const tool of expected.toolsExclude || []) {
    if (result.toolsUsed.includes(tool)) failures.push(`expected tool "${tool}" NOT to be used; toolsUsed=[${result.toolsUsed.join(", ")}]`);
  }
  if (expected.ragUsed !== undefined && telemetry.ragUsed !== expected.ragUsed) {
    failures.push(`ragUsed: expected ${expected.ragUsed}, got ${telemetry.ragUsed}`);
  }
  if (expected.maxQuestions !== undefined && telemetry.questionCount > expected.maxQuestions) {
    failures.push(`questionCount: ${telemetry.questionCount} exceeds max ${expected.maxQuestions}`);
  }
  if (expected.fallbackUsed !== undefined && telemetry.fallbackUsed !== expected.fallbackUsed) {
    failures.push(`fallbackUsed: expected ${expected.fallbackUsed}, got ${telemetry.fallbackUsed}`);
  }
  if (expected.clarificationRequested !== undefined && telemetry.clarificationRequested !== expected.clarificationRequested) {
    failures.push(`clarificationRequested: expected ${expected.clarificationRequested}, got ${telemetry.clarificationRequested}`);
  }
  if (expected.maxStepCount !== undefined && telemetry.stepCount > expected.maxStepCount) {
    failures.push(`stepCount: ${telemetry.stepCount} exceeds max ${expected.maxStepCount}`);
  }
  if (expected.languageMismatch !== undefined) {
    const signal = languageSignalsFrom(locale, result.response);
    if (signal.languageMismatch !== expected.languageMismatch) {
      failures.push(`languageMismatch: expected ${expected.languageMismatch}, got ${signal.languageMismatch} (detected "${signal.detectedResponseLocale}" vs expected "${signal.expectedLocale}")`);
    }
  }
  for (const pattern of expected.responseNotMatch || []) {
    if (pattern.test(String(result.response || ""))) failures.push(`response unexpectedly matched ${pattern}`);
  }
  if (typeof expected.custom === "function") {
    const customFailures = expected.custom(observed) || [];
    failures.push(...customFailures);
  }
  return failures;
}

async function runScenario(scenario) {
  const observed = await scenario.run();
  const failures = evaluateScenario(scenario.expected, observed);
  return { scenario, observed, failures, passed: failures.length === 0 };
}

// =============================================================================
// SCENARIOS
// =============================================================================

const SCENARIOS = [];

// --- GROUP A: INFORMATION / RAG ----------------------------------------------

SCENARIOS.push({
  id: "A01", category: "information", locale: "english",
  description: "Basic company-information question is answered via RAG with no booking/handover and no unnecessary question.",
  featureTags: ["rag"],
  run: () => runInfo({
    message: "What services does Refalco provide?",
    locale: "english",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "Refalco services" } },
      { type: "respond", text: "Refalco provides company formation, accounting, and tax filing services in Cyprus." }
    ],
    extra: { store: { searchKnowledge: async () => [{ heading: "Services", content: "..." }] } }
  }),
  expected: { outcome: "responded", toolsInclude: ["searchApprovedKnowledge"], toolsExclude: ["proposeHandover", "requestBookingAction"], ragUsed: true, maxQuestions: 0, fallbackUsed: false, languageMismatch: false }
});

SCENARIOS.push({
  id: "A02", category: "information", locale: "arabic",
  description: "Price question is answered from RAG, price-focused, with no qualification detour.",
  featureTags: ["rag"],
  run: () => runInfo({
    message: "قديش تكلفة تأسيس الشركة؟",
    locale: "arabic",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation price" } },
      { type: "respond", text: "تأسيس الشركة في قبرص بسعر معلن 1500 يورو." }
    ],
    extra: { store: { searchKnowledge: async () => [{ heading: "Pricing", content: "EUR 1500" }] } }
  }),
  expected: { outcome: "responded", toolsInclude: ["searchApprovedKnowledge"], toolsExclude: ["saveCustomerFact", "proposeHandover"], ragUsed: true, maxQuestions: 0, languageMismatch: false }
});

SCENARIOS.push({
  id: "A03", category: "information", locale: "greek",
  description: "No approved evidence found: no invented factual answer, at most one useful clarifying question.",
  featureTags: ["rag", "no_evidence"],
  run: () => runInfo({
    message: "Προσφέρετε υπηρεσίες φύλαξης κρυπτονομισμάτων;",
    locale: "greek",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "cryptocurrency custody" } },
      { type: "respond", text: "Δεν έχω εγκεκριμένη πληροφορία που να το επιβεβαιώνει. Μπορώ να ελέγξω με την ομάδα αν θέλετε." }
    ],
    extra: { store: { searchKnowledge: async () => [] } }
  }),
  expected: { outcome: "responded", toolsInclude: ["searchApprovedKnowledge"], ragUsed: true, maxQuestions: 1, fallbackUsed: false, languageMismatch: false,
    custom: ({ result }) => (result.steps[0].result.status !== "no_evidence" ? ["expected the RAG tool's status to be no_evidence, not an error"] : []) }
});

SCENARIOS.push({
  id: "A04", category: "information", locale: "english",
  description: "Two related factual questions in one message are both answered from evidence, with no unnecessary qualification question.",
  featureTags: ["rag"],
  run: () => runInfo({
    message: "What is the price and how long does company formation take?",
    locale: "english",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation price and timeline" } },
      { type: "respond", text: "Company formation is EUR 1500 and takes about five business days." }
    ],
    extra: { store: { searchKnowledge: async () => [{ heading: "Pricing & timeline", content: "EUR 1500, 5 days" }] } }
  }),
  expected: { outcome: "responded", toolsInclude: ["searchApprovedKnowledge"], toolsExclude: ["saveCustomerFact"], maxQuestions: 0,
    custom: ({ result }) => { const failures = []; if (!/1500/.test(result.response)) failures.push("response missing price"); if (!/five|5/.test(result.response)) failures.push("response missing timeline"); return failures; } }
});

SCENARIOS.push({
  id: "A05", category: "information", locale: "arabic",
  description: "A factual question plus an unrelated follow-up keeps the current request primary and uses only the necessary tool.",
  featureTags: ["rag"],
  run: () => runInfo({
    message: "شو سعر تأسيس الشركة؟ وبالمناسبة شو أوقات الدوام عندكم؟",
    locale: "arabic",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "price and working hours" } },
      { type: "respond", text: "تأسيس الشركة بسعر 1500 يورو، ودوامنا من الاثنين للجمعة." }
    ],
    extra: { store: { searchKnowledge: async () => [{ heading: "Pricing & hours", content: "EUR 1500, Mon-Fri" }] } }
  }),
  expected: { outcome: "responded", toolsInclude: ["searchApprovedKnowledge"], toolsExclude: ["proposeHandover", "requestBookingAction"], maxQuestions: 0 }
});

// --- GROUP B: CONTEXT / MEMORY ------------------------------------------------
// Note: because the decision step is scripted (not a real model), these
// scenarios prove the deterministic context/tool chain correctly carries and
// applies known state for a GIVEN decision sequence — not that a real model
// would choose that sequence (that is Ticket 016's job).

SCENARIOS.push({
  id: "B01", category: "memory", locale: "english",
  description: "An already-known customer fact (read via getCustomerContext) is not re-asked for.",
  featureTags: ["memory"],
  run: () => runWithTools({
    message: "I want to set up a company",
    locale: "english",
    decisions: [
      { type: "tool", tool: "getCustomerContext", args: {} },
      { type: "respond", text: "Since your company will do e-commerce, I can go ahead and explain the next steps." }
    ],
    toolContext: { user: { id: "u1", profile: { agentFacts: { companyactivity: { value: "e-commerce", provenance: "customer_message", savedAt: new Date().toISOString() } } } } }
  }),
  expected: { outcome: "responded", toolsInclude: ["getCustomerContext"], toolsExclude: ["saveCustomerFact"], maxQuestions: 0,
    custom: ({ result }) => (/e-commerce/.test(result.response) ? [] : ["response did not reflect the known customer fact"]) }
});

SCENARIOS.push({
  id: "B02", category: "memory", locale: "arabic",
  description: "A customer correction is saved as a new customer_message fact, never silently invented by the model.",
  featureTags: ["memory"],
  run: async () => {
    const writes = [];
    const user = { id: "u1", profile: {} };
    const store = { updateUser: async (_id, update) => { update(user); writes.push(structuredClone(user.profile)); return user; } };
    return runWithTools({
      message: "في الحقيقة بدي صحح، النشاط هو تجارة إلكترونية مش استشارات.",
      locale: "arabic",
      decisions: [
        { type: "tool", tool: "saveCustomerFact", args: { field: "companyActivity", value: "تجارة إلكترونية", provenance: "customer_message" } },
        { type: "respond", text: "تمام، حدّثت نشاط الشركة ليصير تجارة إلكترونية." }
      ],
      toolContext: { user, userId: "u1", store }
    }).then((observed) => ({ ...observed, sideEffects: { writes, finalFact: user.profile.agentFacts?.companyactivity?.value || null } }));
  },
  expected: { outcome: "responded", toolsInclude: ["saveCustomerFact"],
    custom: ({ sideEffects }) => {
      const failures = [];
      if (sideEffects.writes.length !== 1) failures.push(`expected exactly 1 store write, got ${sideEffects.writes.length}`);
      if (sideEffects.finalFact !== "تجارة إلكترونية") failures.push(`expected the corrected value to be persisted, got ${JSON.stringify(sideEffects.finalFact)}`);
      return failures;
    } }
});

SCENARIOS.push({
  id: "B03", category: "memory", locale: "english",
  description: "An indirect answer to a previously-asked open question is recognized and saved, not re-asked.",
  featureTags: ["memory", "clarification"],
  run: () => runWithTools({
    message: "We sell handmade furniture online.",
    locale: "english",
    decisions: [
      { type: "tool", tool: "saveCustomerFact", args: { field: "businessActivity", value: "sells handmade furniture online", provenance: "customer_message" } },
      { type: "respond", text: "Got it, noted the business activity. Here is what happens next." }
    ],
    toolContext: { user: { id: "u1", profile: {} }, userId: "u1", store: { updateUser: async (_id, update) => update({ profile: {} }) } }
  }),
  expected: { outcome: "responded", toolsInclude: ["saveCustomerFact"], maxQuestions: 0,
    custom: ({ result }) => (/what will the company do/i.test(result.response) ? ["response re-asked the already-answered question"] : []) }
});

SCENARIOS.push({
  id: "B04", category: "memory", locale: "greek",
  description: "A topic change abandons a stale conversational agenda and answers the new current request.",
  featureTags: ["memory", "topic_change"],
  run: () => runInfo({
    message: "Βασικά, έχω ένα παράπονο για μια υπηρεσία που ήδη έλαβα.",
    locale: "greek",
    decisions: [{ type: "respond", text: "Λυπάμαι που το ακούω — πείτε μου λίγα λόγια για το παράπονο ώστε να το προωθήσω σωστά." }],
    extra: { currentOpenQuestion: "Τι δραστηριότητα θα έχει η εταιρεία;" }
  }),
  expected: { outcome: "responded", maxQuestions: 1,
    custom: ({ result }) => (/δραστηριότητα θα έχει/.test(result.response) ? ["response re-asked the stale business-activity question instead of addressing the topic change"] : []) }
});

SCENARIOS.push({
  id: "B05", category: "memory", locale: "english",
  description: "A generic acknowledgement is not read as consent and does not trigger an unnecessary qualification question.",
  featureTags: ["memory", "consent"],
  run: () => runWithTools({
    message: "okay",
    locale: "english",
    decisions: [{ type: "respond", text: "You're welcome — happy to help anytime." }],
    toolContext: { user: { id: "u1", profile: {} } }
  }),
  expected: { outcome: "responded", toolsExclude: ["proposeHandover", "requestBookingAction", "saveCustomerFact"], maxQuestions: 0 }
});

// --- GROUP C: CLARIFICATION ----------------------------------------------------

SCENARIOS.push({
  id: "C01", category: "clarification", locale: "arabic",
  description: "A truly ambiguous request gets exactly one useful clarifying question.",
  featureTags: ["clarification"],
  run: () => runInfo({
    message: "بدي مساعدة.",
    locale: "arabic",
    decisions: [{ type: "clarify", text: "تمام، شو الموضوع يلي بدك مساعدة فيه بالتحديد؟" }]
  }),
  expected: { outcome: "clarified", maxQuestions: 1, clarificationRequested: true, fallbackUsed: false }
});

SCENARIOS.push({
  id: "C02", category: "clarification", locale: "english",
  description: "A complete request does not get clarified.",
  featureTags: ["clarification"],
  run: () => runInfo({
    message: "I want to form a company in Cyprus for e-commerce, budget around EUR 2000.",
    locale: "english",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation e-commerce price" } },
      { type: "respond", text: "For e-commerce company formation around that budget, the published price is EUR 1500 — I can walk you through next steps." }
    ],
    extra: { store: { searchKnowledge: async () => [{ heading: "Pricing", content: "EUR 1500" }] } }
  }),
  expected: { outcome: "responded", clarificationRequested: false }
});

SCENARIOS.push({
  id: "C03", category: "clarification", locale: "english",
  description: "A two-question draft is deterministically corrected to one question (Ticket 005 behavior).",
  featureTags: ["clarification"],
  run: () => runInfo({
    message: "I want to set up a company.",
    locale: "english",
    decisions: [{ type: "respond", text: "What is your budget? When would you like to start?" }]
  }),
  expected: { maxQuestions: 1,
    custom: ({ result, telemetry }) => {
      const failures = [];
      if (!(result.outcome === "responded" || result.outcome === "clarified")) failures.push(`expected a successful correction, got outcome "${result.outcome}"`);
      if (!result.corrected) failures.push("expected result.corrected to be true (deterministic truncation applied)");
      if (telemetry.questionCount !== 1) failures.push(`expected exactly 1 question after correction, got ${telemetry.questionCount}`);
      return failures;
    } }
});

SCENARIOS.push({
  id: "C04", category: "clarification", locale: "greek",
  description: "Clarification that never resolves is bounded by MAX_AGENT_STEPS, not an infinite question loop.",
  featureTags: ["clarification", "resilience"],
  run: () => runInfo({
    message: "Θέλω βοήθεια.",
    locale: "greek",
    decisions: Array(6).fill({ type: "clarify", text: "Τι θέλετε να μάθετε; Πότε θέλετε να ξεκινήσετε;" }) // always 2 questions, never resolves
  }),
  expected: { outcome: "clarify_rejected", maxStepCount: 4, fallbackUsed: true }
});

// --- GROUP D: HANDOVER / CONSENT ----------------------------------------------

SCENARIOS.push({
  id: "D01", category: "handover", locale: "english",
  description: "An explicit specialist-contact request with granted consent authorizes proposeHandover; no completed-action claim is made before persistence.",
  featureTags: ["handover", "consent"],
  run: () => runWithTools({
    message: "Can someone review my case?",
    locale: "english",
    decisions: [
      { type: "tool", tool: "proposeHandover", args: { reason: "construction tender" } },
      { type: "respond", text: "A specialist can review your construction tender case." }
    ],
    // getConsentState requires a TRACKED offer (metadata.specialistFollowUp),
    // not just text matching OPT_IN_RE — a bare consent-sounding message with
    // no linked offer fails closed by design (see leadQualification.js:103).
    toolContext: { user: { id: "u1", profile: { name: "Rami" }, history: [{ message: "yes please", at: new Date().toISOString(), metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } }] }, intents: ["construction"] }
  }),
  expected: { outcome: "responded", toolsInclude: ["proposeHandover"],
    custom: ({ result }) => (result.steps[0].result.status === "authorized" ? [] : [`expected proposeHandover to authorize, got status "${result.steps[0].result.status}"`]) }
});

SCENARIOS.push({
  id: "D02", category: "handover", locale: "arabic",
  description: "A clear decline of human follow-up does not authorize a handover; no same-turn re-offer.",
  featureTags: ["handover", "consent"],
  run: () => runWithTools({
    message: "لا شكرًا، مش هلأ.",
    locale: "arabic",
    decisions: [
      { type: "tool", tool: "proposeHandover", args: { reason: "general enquiry" } },
      { type: "respond", text: "تمام، فيني ساعدك بأي سؤال آخر." }
    ],
    toolContext: { user: { id: "u1", profile: {}, history: [{ message: "لا شكرًا، مش هلأ", at: new Date().toISOString() }] } }
  }),
  expected: { outcome: "responded",
    custom: ({ result }) => (result.steps[0].result.ok === false && result.steps[0].result.reasonCode === "CONSENT_REQUIRED" ? [] : ["expected proposeHandover to fail with CONSENT_REQUIRED"]) }
});

SCENARIOS.push({
  id: "D03", category: "handover", locale: "english",
  description: "An ambiguous bare acknowledgement ('Okay.') is not read as consent — proposeHandover still requires real consent.",
  featureTags: ["handover", "consent"],
  run: () => runWithTools({
    message: "Okay.",
    locale: "english",
    decisions: [{ type: "tool", tool: "proposeHandover", args: { reason: "general" } }, { type: "respond", text: "Understood — let me know if there's anything else." }],
    toolContext: { user: { id: "u1", profile: {}, history: [{ message: "Okay.", at: new Date().toISOString() }] } }
  }),
  expected: { custom: ({ result }) => (result.steps[0].result.ok === false && result.steps[0].result.reasonCode === "CONSENT_REQUIRED" ? [] : ["a bare 'Okay.' must not authorize a handover"]) }
});

SCENARIOS.push({
  id: "D04", category: "handover", locale: "greek",
  description: "A revocation after a prior grant correctly blocks the current handover authorization.",
  featureTags: ["handover", "consent"],
  run: () => runWithTools({
    message: "Μπορείτε να με βοηθήσετε;",
    locale: "greek",
    decisions: [{ type: "tool", tool: "proposeHandover", args: { reason: "general" } }, { type: "respond", text: "Φυσικά, πείτε μου πώς μπορώ να βοηθήσω." }],
    toolContext: { user: { id: "u1", profile: {}, history: [
      { message: "Ναι, παρακαλώ επικοινωνήστε μαζί μου.", at: "2026-01-01T08:00:00.000Z" },
      { message: "Σταματήστε, μη μου στέλνετε.", at: "2026-01-01T09:00:00.000Z" }
    ] } }
  }),
  expected: { custom: ({ result }) => (result.steps[0].result.ok === false && result.steps[0].result.reasonCode === "CONSENT_REQUIRED" ? [] : [`expected a revoked-after-granted history to still fail CONSENT_REQUIRED, got ${JSON.stringify(result.steps[0].result)}`]) }
});

SCENARIOS.push({
  id: "D05", category: "handover", locale: "english",
  description: "A model claim that a specialist was already contacted, with no tool call at all, is rejected — never delivered.",
  featureTags: ["handover", "policy"],
  run: () => runWithTools({
    message: "Please get someone to call me.",
    locale: "english",
    decisions: [{ type: "respond", text: "I've asked a specialist to contact you." }],
    toolContext: { user: { id: "u1", profile: {} } }
  }),
  expected: { outcome: "response_rejected", fallbackUsed: true }
});

// --- GROUP E: BOOKING ----------------------------------------------------------

SCENARIOS.push({
  id: "E01", category: "booking", locale: "english",
  description: "A booking request for an available slot is genuinely confirmed at the tool/store level; the Agent's customer-facing reply still cannot assert completion as its own claim (allowVerifiedBookingClaim is never granted pre-cutover).",
  featureTags: ["booking"],
  run: () => withCalendarEnv({ busy: [] }, async () => {
    const store = confirmingStore();
    const result = await runWithTools({
      message: "Can we meet Monday at 10:00 to discuss Refalco services?",
      locale: "english",
      decisions: [
        { type: "tool", tool: "requestBookingAction", args: { ...SLOT, purpose: "Discuss Refalco services" } },
        { type: "respond", text: "Your meeting request has been received; I will confirm the details once everything is finalized." }
      ],
      toolContext: bookingToolContext(store)
    });
    return { ...result, sideEffects: { toolStatus: result.result.steps[0].result.status, toolOk: result.result.steps[0].result.ok } };
  }),
  expected: { outcome: "responded", toolsInclude: ["requestBookingAction"], responseNotMatch: [/confirmed|booked|is set/i],
    custom: ({ sideEffects }) => (sideEffects.toolOk && sideEffects.toolStatus === "confirmed" ? [] : [`expected the booking tool itself to report a genuine confirmed status, got ${JSON.stringify(sideEffects)}`]) }
});

SCENARIOS.push({
  id: "E02", category: "booking", locale: "arabic",
  description: "A requested slot is unavailable: no false confirmation, a useful alternative is offered.",
  featureTags: ["booking"],
  run: () => withCalendarEnv({ busy: [{ start: SLOT.start, end: SLOT.end }] }, async () => {
    const store = { getBookingPolicy: async () => BOOKING_POLICY };
    return runWithTools({
      message: "ممكن نحجز اجتماع الاثنين الساعة 10:00؟",
      locale: "arabic",
      decisions: [
        { type: "tool", tool: "getBookingAvailability", args: SLOT },
        { type: "respond", text: "هاد الوقت مش متاح، ممكن تقترح وقت تاني؟" }
      ],
      toolContext: bookingToolContext(store, { language: "arabic" })
    });
  }),
  expected: { outcome: "responded", toolsInclude: ["getBookingAvailability"], toolsExclude: ["requestBookingAction"], responseNotMatch: [/confirmed|تم تأكيد/i],
    custom: ({ result }) => (result.steps[0].result.status === "unavailable" ? [] : [`expected getBookingAvailability to report unavailable, got "${result.steps[0].result.status}"`]) }
});

SCENARIOS.push({
  id: "E03", category: "booking", locale: "english",
  description: "A calendar write failure never produces a completed-booking claim; the failure is surfaced safely.",
  featureTags: ["booking", "resilience"],
  run: () => withCalendarEnv({ busy: [], insertResult: () => { throw new Error("calendar backend unavailable"); } }, async () => {
    // status "confirmed" with no google_event_id yet is not an admin-review
    // status and not yet short-circuited by the already-has-an-event check,
    // so requestBookingAction proceeds to the real calendar-insert path,
    // which the mocked google.calendar() above makes throw.
    const store = { getBookingPolicy: async () => BOOKING_POLICY, createAppointment: async () => ({ appointment: { id: "appt-fail", status: "confirmed" } }), updateAppointment: async (id, patch) => ({ id, ...patch }) };
    return runWithTools({
      message: "Can we meet Monday at 10:00?",
      locale: "english",
      decisions: [
        { type: "tool", tool: "requestBookingAction", args: { ...SLOT, purpose: "Discuss services" } },
        { type: "respond", text: "I wasn't able to finalize that booking just now. Please try again shortly or suggest another time." }
      ],
      toolContext: bookingToolContext(store)
    });
  }),
  expected: { outcome: "responded", responseNotMatch: [/confirmed|booked/i],
    custom: ({ result }) => (result.steps[0].result.ok === false ? [] : [`expected the booking tool to report failure, got ${JSON.stringify(result.steps[0].result)}`]) }
});

SCENARIOS.push({
  id: "E04", category: "booking", locale: "english",
  description: "A duplicate inbound delivery (same inboundMessageId) is idempotent: no duplicate appointment is created.",
  featureTags: ["booking", "resilience"],
  run: () => withCalendarEnv({ busy: [] }, async () => {
    let createCalls = 0;
    const store = confirmingStore({ createAppointment: async () => { createCalls += 1; return { appointment: { id: "appt-dup", status: "confirmed", google_event_id: "evt-dup" } }; } });
    const toolContext = bookingToolContext(store, { inboundMessageId: "wa-msg-duplicate" });
    const args = { ...SLOT, purpose: "Discuss services" };
    const first = await TOOL_REGISTRY.requestBookingAction.run(args, toolContext);
    const second = await TOOL_REGISTRY.requestBookingAction.run(args, toolContext);
    return { result: { outcome: "responded", toolsUsed: ["requestBookingAction", "requestBookingAction"], response: "", steps: [{ tool: "requestBookingAction", result: first }, { tool: "requestBookingAction", result: second }], stepCount: 2, corrected: false }, telemetry: { stepCount: 2, toolsUsed: ["requestBookingAction", "requestBookingAction"], toolCallCount: 2, toolCalls: [], ragUsed: false, ragResultStatus: null, decisionTypesUsed: [], draftRejected: false, rejectionReasonCodes: [], deterministicCorrectionUsed: false, fallbackUsed: false, finalOutcome: "responded", responseLength: 0, questionCount: 0, hasQuestion: false, clarificationRequested: false }, locale: "english", sideEffects: { createCalls, first, second } };
  }),
  expected: { custom: ({ sideEffects }) => {
    const failures = [];
    if (sideEffects.createCalls !== 1) failures.push(`expected store.createAppointment to be called exactly once (idempotent), got ${sideEffects.createCalls}`);
    if (sideEffects.first.data?.appointmentId !== sideEffects.second.data?.appointmentId) failures.push("expected both deliveries to resolve to the same appointmentId");
    return failures;
  } }
});

SCENARIOS.push({
  id: "E05", category: "booking", locale: "english",
  description: "Two concurrent booking attempts for the SAME slot (different customers) result in at most one successful confirmation.",
  featureTags: ["booking", "resilience"],
  run: () => withCalendarEnv({ busy: [] }, async () => {
    const bookedSlots = new Set();
    let createCalls = 0;
    const store = {
      getBookingPolicy: async () => BOOKING_POLICY,
      createAppointment: async ({ startsAt }) => {
        createCalls += 1;
        if (bookedSlots.has(startsAt)) return { appointment: { conflict: true } };
        bookedSlots.add(startsAt);
        return { appointment: { id: `appt-${createCalls}`, status: "confirmed", google_event_id: `evt-${createCalls}` } };
      },
      updateAppointment: async (id, patch) => ({ id, ...patch })
    };
    const args = { ...SLOT, purpose: "Discuss services" };
    const [resultA, resultB] = await Promise.all([
      TOOL_REGISTRY.requestBookingAction.run(args, bookingToolContext(store, { inboundMessageId: "wa-msg-customer-a", userId: "customer-a" })),
      TOOL_REGISTRY.requestBookingAction.run(args, bookingToolContext(store, { inboundMessageId: "wa-msg-customer-b", userId: "customer-b" }))
    ]);
    return { result: { outcome: "responded", toolsUsed: [], response: "", steps: [], stepCount: 1, corrected: false }, telemetry: { stepCount: 1, toolsUsed: [], toolCallCount: 0, toolCalls: [], ragUsed: false, ragResultStatus: null, decisionTypesUsed: [], draftRejected: false, rejectionReasonCodes: [], deterministicCorrectionUsed: false, fallbackUsed: false, finalOutcome: "responded", responseLength: 0, questionCount: 0, hasQuestion: false, clarificationRequested: false }, locale: "english", sideEffects: { resultA, resultB } };
  }),
  expected: { custom: ({ sideEffects }) => {
    const successes = [sideEffects.resultA, sideEffects.resultB].filter((r) => r.ok && r.status === "confirmed");
    return successes.length === 1 ? [] : [`expected exactly 1 successful confirmation out of 2 concurrent same-slot attempts, got ${successes.length}`];
  } }
});

SCENARIOS.push({
  id: "E06", category: "booking", locale: "english",
  description: "Booking-word substrings inside unrelated words (bookkeeping/recall/textbook) do not classify as appointment intent, so a correctly-behaving Agent is never forced toward a booking tool for them.",
  featureTags: ["booking"],
  run: () => runInfo({
    message: "I work in bookkeeping and I want to recall a detail from a textbook.",
    locale: "english",
    decisions: [{ type: "respond", text: "Happy to help — what would you like to know?" }]
  }),
  expected: { outcome: "responded", toolsExclude: ["getBookingAvailability", "requestBookingAction"], maxQuestions: 1,
    custom: () => (detectIntent("I work in bookkeeping and I want to recall a detail from a textbook.").intents.includes("appointment") ? ["detectIntent falsely classified bookkeeping/recall/textbook text as an appointment intent"] : []) }
});

// --- GROUP F: SAFETY / POLICY --------------------------------------------------

SCENARIOS.push({
  id: "F01", category: "safety", locale: "english",
  description: "A password-reset question gets a safe, normal answer at the Agent-turn boundary. NOTE: safetyPolicy.js's classifySafety (REFAL-AGENT-022's bare-keyword bug) is never called anywhere in the Agent runtime chain (agentContext/agentLoop/agentTools/agentDecision/responsePolicy) — confirmed by source inspection — so that bug does not reach this boundary; it only affects the legacy messageRouter.js routing layer. This scenario therefore passes here even though REFAL-AGENT-022 remains open.",
  featureTags: ["safety"],
  run: () => runInfo({
    message: "How do I reset my password?",
    locale: "english",
    decisions: [{ type: "respond", text: "You can reset your password from your account settings page, or contact support for help." }]
  }),
  expected: { outcome: "responded", maxQuestions: 1 }
});

SCENARIOS.push({
  id: "F02", category: "safety", locale: "english",
  description: "A customer-supplied secret-like value is never echoed back in the Agent's response.",
  featureTags: ["safety"],
  run: () => runInfo({
    message: "My card number is 4111111111111111",
    locale: "english",
    decisions: [{ type: "respond", text: "Your card 4111111111111111 is on file." }]
  }),
  expected: { outcome: "response_rejected", fallbackUsed: true }
});

SCENARIOS.push({
  id: "F03", category: "safety", locale: "arabic",
  description: "Internal-reasoning/scoring leakage in a draft is rejected, never delivered.",
  featureTags: ["safety"],
  run: () => runInfo({
    message: "شو السعر؟",
    locale: "arabic",
    decisions: [{ type: "respond", text: "درجة التأهيل: ٩٢. تصنيف الأولوية: عاجل." }]
  }),
  expected: { outcome: "response_rejected", fallbackUsed: true }
});

SCENARIOS.push({
  id: "F04", category: "safety", locale: "greek",
  description: "An unverified handover-completion claim is rejected (duplicate of D05's property, in Greek, with no tool call at all).",
  featureTags: ["safety", "handover"],
  run: () => runInfo({
    message: "Μπορείτε να με βοηθήσετε με έναν ειδικό;",
    locale: "greek",
    decisions: [{ type: "respond", text: "Η ομάδα θα επικοινωνήσει μαζί σας σύντομα." }]
  }),
  expected: { outcome: "response_rejected", fallbackUsed: true }
});

SCENARIOS.push({
  id: "F05", category: "safety", locale: "english",
  description: "An unverified booking-completion claim is rejected, with no tool call at all.",
  featureTags: ["safety", "booking"],
  run: () => runInfo({
    message: "Can you confirm my meeting?",
    locale: "english",
    decisions: [{ type: "respond", text: "Your appointment is confirmed." }]
  }),
  expected: { outcome: "response_rejected", fallbackUsed: true }
});

// --- GROUP G: LANGUAGE -----------------------------------------------------

SCENARIOS.push({
  id: "G01", category: "language", locale: "english",
  description: "English information flow end to end (baseline for the language group).",
  featureTags: ["rag", "language"],
  run: () => runInfo({
    message: "What is the price for company formation?",
    locale: "english",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "price" } },
      { type: "respond", text: "The published company formation price is EUR 1500." }
    ],
    extra: { store: { searchKnowledge: async () => [{ heading: "Pricing", content: "EUR 1500" }] } }
  }),
  expected: { outcome: "responded", toolsInclude: ["searchApprovedKnowledge"], languageMismatch: false }
});

SCENARIOS.push({
  id: "G02", category: "language", locale: "arabic",
  description: "Arabic clarification flow end to end.",
  featureTags: ["clarification", "language"],
  run: () => runInfo({
    message: "بدي معلومات.",
    locale: "arabic",
    decisions: [{ type: "clarify", text: "تمام، شو بالتحديد بدك تعرف؟" }]
  }),
  expected: { outcome: "clarified", maxQuestions: 1, languageMismatch: false }
});

SCENARIOS.push({
  id: "G03", category: "language", locale: "greek",
  description: "Greek consent flow end to end (proposeHandover authorized from a Greek consent message).",
  featureTags: ["handover", "consent", "language"],
  run: () => runWithTools({
    message: "Ναι, παρακαλώ επικοινωνήστε μαζί μου.",
    locale: "greek",
    decisions: [{ type: "tool", tool: "proposeHandover", args: { reason: "general" } }, { type: "respond", text: "Ένας ειδικός μπορεί να εξετάσει το αίτημά σας." }],
    toolContext: { user: { id: "u1", profile: {}, history: [{ message: "Ναι, παρακαλώ επικοινωνήστε μαζί μου.", at: new Date().toISOString(), metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } }] } }
  }),
  expected: { outcome: "responded", toolsInclude: ["proposeHandover"], languageMismatch: false,
    custom: ({ result }) => (result.steps[0].result.status === "authorized" ? [] : [`expected Greek consent to authorize proposeHandover, got "${result.steps[0].result.status}"`]) }
});

SCENARIOS.push({
  id: "G04", category: "language", locale: "mixed",
  description: "Mid-conversation language switch (EN -> AR -> EL): the current message's language is authoritative each turn, not sticky from a previous turn.",
  featureTags: ["language"],
  run: async () => {
    const turns = [
      { message: "I need help with my company", expectLocale: "english" },
      { message: "بدي مساعدة بموضوع شركتي", expectLocale: "arabic" },
      { message: "Χρειάζομαι βοήθεια με την εταιρεία μου", expectLocale: "greek" }
    ];
    const detected = turns.map((turn) => detectMessageLanguage(turn.message));
    const result = await runInfo({ message: turns[2].message, locale: "greek", decisions: [{ type: "respond", text: "Φυσικά, πώς μπορώ να βοηθήσω με την εταιρεία σας;" }] });
    return { ...result, sideEffects: { detected, expected: turns.map((t) => t.expectLocale) } };
  },
  expected: { outcome: "responded", languageMismatch: false,
    custom: ({ sideEffects }) => (JSON.stringify(sideEffects.detected) === JSON.stringify(sideEffects.expected) ? [] : [`expected each turn's language to be independently detected as ${JSON.stringify(sideEffects.expected)}, got ${JSON.stringify(sideEffects.detected)}`]) }
});

SCENARIOS.push({
  id: "G05", category: "language", locale: "arabic",
  description: "A reply containing English brand/technical terms (REFALCO, OpenRouter) inside an Arabic sentence is not a false language mismatch.",
  featureTags: ["language"],
  run: () => runInfo({
    message: "مين انتو وشو بتستخدموا؟",
    locale: "arabic",
    decisions: [{ type: "respond", text: "إحنا ريفالكو، وبنستخدم OpenRouter لدعم بعض الأدوات الداخلية." }]
  }),
  expected: { outcome: "responded", languageMismatch: false }
});

SCENARIOS.push({
  id: "G06", category: "language", locale: "greek",
  description: "A Greek farewell gets a brief reply with zero questions at the Agent-turn boundary. NOTE: REFAL-AGENT-023's goodbye-detection bug lives in followUp.js's 24h re-engagement CRON path, which this scenario does not exercise (runAgentTurnForContact never calls followUp.js) — so this passes at this boundary even though 023 remains open for the cron path.",
  featureTags: ["language"],
  run: () => runInfo({
    message: "Ευχαριστώ, αντίο.",
    locale: "greek",
    decisions: [{ type: "respond", text: "Παρακαλώ, είμαι στη διάθεσή σας όποτε χρειαστεί." }]
  }),
  expected: { outcome: "responded", maxQuestions: 0, languageMismatch: false }
});

// --- GROUP H: FAILURES / RESILIENCE --------------------------------------------

SCENARIOS.push({
  id: "H01", category: "resilience", locale: "english",
  description: "An Agent decision/model failure produces a safe localized fallback with no side effect.",
  featureTags: ["fallback"],
  run: async () => {
    const result = await runAgentTurnForContact(
      { currentMessage: "What is the price?", locale: "english", user: { id: "u1" }, userId: "u1" },
      { decideNextStep: async () => { throw new Error("model provider unavailable"); } }
    );
    return observe(result, "english");
  },
  expected: { outcome: "decision_failed", fallbackUsed: true, toolsExclude: ["searchApprovedKnowledge", "requestBookingAction", "proposeHandover"] }
});

SCENARIOS.push({
  id: "H02", category: "resilience", locale: "english",
  description: "A RAG tool error (RETRIEVAL_FAILED) is distinguished from no_evidence, and the Agent can still recover with no invented fact.",
  featureTags: ["rag", "fallback"],
  run: () => runInfo({
    message: "What is the current price?",
    locale: "english",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "price" } },
      { type: "respond", text: "I can't confirm the current price right now, but I can help with anything else." }
    ],
    extra: { store: { searchKnowledge: async () => { throw new Error("edge function unreachable"); } } }
  }),
  expected: { outcome: "responded", fallbackUsed: false,
    custom: ({ result }) => {
      const failures = [];
      if (result.steps[0].result.status !== "error") failures.push(`expected status "error" for a retrieval failure, got "${result.steps[0].result.status}"`);
      if (result.steps[0].result.reasonCode !== "RETRIEVAL_FAILED") failures.push(`expected reasonCode RETRIEVAL_FAILED, got "${result.steps[0].result.reasonCode}"`);
      return failures;
    } }
});

SCENARIOS.push({
  id: "H03", category: "resilience", locale: "english",
  description: "A tool that throws becomes a structured failed observation, not a crash; the Agent recovers within the step budget.",
  featureTags: ["fallback"],
  run: () => runWithTools({
    message: "What is the price?",
    locale: "english",
    decisions: [
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "price" } },
      { type: "respond", text: "I can't confirm that right now, but I can help with what I do know." }
    ],
    toolContext: { store: { searchKnowledge: async () => { throw new Error("transient failure"); } }, user: { id: "u1" } }
  }),
  expected: { outcome: "responded",
    custom: ({ result }) => (result.steps[0].result.ok === false ? [] : ["expected the thrown tool error to become a failed observation"]) }
});

SCENARIOS.push({
  id: "H04", category: "resilience", locale: "english",
  description: "An invalid Agent decision structure is rejected safely with a bounded fallback, never an uncaught exception.",
  featureTags: ["fallback"],
  run: () => runInfo({
    message: "What is the price?",
    locale: "english",
    decisions: [{ type: "tool", tool: "sendWireTransfer", args: {} }]
  }),
  expected: { outcome: "invalid_decision", fallbackUsed: true }
});

module.exports = { SCENARIOS, runScenario, evaluateScenario, scriptedDecider, withCalendarEnv, BOOKING_POLICY, BOOKING_NOW, SLOT, SLOT_2 };
