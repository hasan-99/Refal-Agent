// REFAL-AGENT-016 — real-model benchmark: legacy deterministic routing vs.
// the new Agent runtime, driven by the REAL decision step (src/agentDecision.js)
// wherever network/credentials allow it.
//
// SAFETY: every store used here is an in-memory fake; every booking scenario
// runs inside agentScenarios.js's withCalendarEnv mock. Nothing in this file
// can send a WhatsApp message, create a real Google Calendar event, create a
// real handover, or write to production Supabase. The only real network
// calls this script makes are to the Agent DECISION model and the benchmark
// EVALUATOR model (both read-only judgments, never a business action).
//
// Usage:
//   node scripts/runAgentBenchmark.js [--runs=3] [--locale=english] [--scenario=A01] [--output=artifacts/refal-agent-benchmark.json]
//   (or BENCHMARK_RUNS / BENCHMARK_LOCALE / BENCHMARK_SCENARIO / BENCHMARK_OUTPUT env vars)

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { loadProjectEnv } = require("../src/env");

const ROOT = path.join(__dirname, "..");
loadProjectEnv(ROOT);

const { runAgentTurn } = require("../src/agentLoop");
const { runAgentTurnForContact } = require("../src/agentRuntime");
const { buildAgentContext } = require("../src/agentContext");
const { decideNextStep: realDecideNextStep } = require("../src/agentDecision");
const { TOOL_REGISTRY } = require("../src/agentTools");
const { summarizeAgentTurn, languageSignalsFrom } = require("../src/agentObservability");
const { buildRecentConversation } = require("../src/agentShadow");
const { getConversationState } = require("../src/conversationState");
const { getConsentState } = require("../src/leadQualification");
const { routeMessageResult } = require("../src/messageRouter");
const { handleBookingMessage } = require("../src/booking");
const { classifySafety, SAFETY_CATEGORIES } = require("../src/safetyPolicy");
const { validateResponse } = require("../src/responsePolicy");
const { judgeResponse, EVALUATOR_PROMPT_VERSION } = require("../src/benchmarkEvaluator");
const { aggregateScenarios, aggregateExcludingKnownTickets } = require("../src/benchmarkScorer");
const { buildReportMarkdown } = require("../src/benchmarkReport");
const { BENCHMARK_SCENARIOS } = require("../src/benchmarkScenarios");
const { withCalendarEnv, BOOKING_POLICY, BOOKING_NOW, SLOT } = require("../src/agentScenarios");
const { resolveOpenRouterModel, DEFAULT_OPENROUTER_MODEL } = require("../src/openrouterPrivacy");
const { DEFAULT_MAX_STEPS } = require("../src/agentLoop");
// REFAL-AGENT-029 — the legacy arm's real AI-routed path, mirroring exactly
// what src/bot.js does today (askOpenRouter + the deterministic
// grounded/localRecap/noApprovedEvidenceReply selection chain), so a legacy
// scenario that routes to AI is actually measured instead of excluded.
const { askOpenRouter, DEFAULT_EMBEDDING_MODEL, redactPersonalData } = require("../src/ai");
const { answerFromEvidence, noApprovedEvidenceReply } = require("../src/refalcoAnswer");
const { buildLocalConversationRecap } = require("../src/conversationRecap");
const { buildConversationContext } = require("../src/conversationMemory");
const { detectMessageLanguage } = require("../src/language");

const UNSAFE_CLAIM_REASONS = new Set(["unverified_handover_action", "unverified_booking_action", "unconsented_contact_commitment"]);

// 2026-10-06 audit (REFAL-AGENT-016 follow-up): the single `unsafeClaim`
// metric conflated two opposite things under one name — "the deterministic
// safety net correctly rejected an unsafe draft before it ever became the
// returned response" vs. "an unsafe claim is actually present in the text
// that would be sent to the customer". Traced via agentLoop.js: every
// `response_rejected`/`clarify_rejected` outcome sets `response:
// safeFallback(context)` (static, pre-approved, non-model text) — the
// rejected draft itself is discarded and never becomes `result.response`.
// `attemptDeterministicCorrection` only ever fires for `too_many_questions`,
// never for a claim-type reason, so a "corrected" outcome can't carry one
// either. These two functions measure the two different things directly
// instead of inferring one from the other.
function unsafeDraftWasBlocked(outcome, rejectionReasonCodes) {
  return (outcome === "response_rejected" || outcome === "clarify_rejected")
    && Array.isArray(rejectionReasonCodes)
    && rejectionReasonCodes.some((code) => UNSAFE_CLAIM_REASONS.has(code));
}

// Measures the actual text that would reach the customer in this harness —
// not an inference from outcome/rejection-reason labels. Run with no
// allow-verified-claim override, mirroring agentLoop.js's own respond/clarify
// validation calls, which never pass `allowVerifiedHandoverClaim`/
// `allowVerifiedBookingClaim` either.
function finalResponseIsUnsafe(responseText) {
  if (typeof responseText !== "string" || !responseText.trim()) return false;
  const check = validateResponse(responseText, {});
  return Boolean(check.unconsentedContactCommitment || check.unverifiedHandoverAction || check.unverifiedBookingAction);
}

// REFAL-AGENT-029 — a judge verdict of CLARIFICATION_WAS_NECESSARY means the
// reply correctly asked instead of guessing; `currentRequestAnswered` is
// forced to null (NOT_APPLICABLE) for exactly these turns so
// benchmarkScorer.js's currentRequestAnsweredRate/unexpectedFailures never
// count a legitimate clarifying question as a "request not answered"
// failure. `clarificationNecessary` carries the signal on its own so
// clarification quality stays visible and reportable, never silently
// dropped. Pure/exported so the derivation is unit-testable without a real
// evaluator model call.
function deriveAnswerMetrics(evaluator) {
  if (!evaluator || evaluator.evaluatorUnavailable) {
    return { currentRequestAnswered: null, unnecessaryQuestion: null, clarificationNecessary: null, evaluatorReasonCode: null };
  }
  const clarificationNecessary = evaluator.reasonCode === "CLARIFICATION_WAS_NECESSARY";
  return {
    currentRequestAnswered: clarificationNecessary ? null : evaluator.currentRequestAnswered,
    unnecessaryQuestion: evaluator.unnecessaryQuestion,
    clarificationNecessary,
    evaluatorReasonCode: evaluator.reasonCode
  };
}

// REFAL-AGENT-029 — "did this booking-category scenario actually exercise
// requestBookingAction" (not merely getBookingAvailability). Only meaningful
// for booking scenarios; every other category reports null (NOT_APPLICABLE),
// never a fabricated false, so the rate denominator only ever counts
// scenarios where this was actually a relevant question.
function bookingToolInvokedMetric(category, toolsUsed) {
  if (category !== "booking") return null;
  return Array.isArray(toolsUsed) && toolsUsed.includes("requestBookingAction");
}

// REFAL-AGENT-029 — a safe/redacted preview of the final customer-visible
// text, stored on the artifact so a human can audit what each arm actually
// produced without re-running anything. Never the drafted-but-rejected text,
// never a prompt, never raw tool args, never reasoning — only the same
// `result.response`/legacy `response` text already scored above, redacted
// with the same personal-data/credential scrubbing `ai.js` already applies
// everywhere else, and bounded in length.
function safeResponsePreview(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  return redactPersonalData(text).slice(0, 500);
}

// REFAL-AGENT-029 — the exact production context-building chain
// (src/agentShadow.js's runShadowAgentTurn), applied to the benchmark's own
// fake `user` object instead of a live store load. Previously the benchmark
// never passed recentConversation/conversationState/consentState at all, so
// memory/clarification/consent/topic-change scenarios ran the real decision
// model with NO conversational history whatsoever — this is the fix. Pure
// and exported so the wiring is directly unit-testable without a real model
// call.
function buildAgentScenarioContext(scenario, user) {
  const history = Array.isArray(user?.history) ? user.history : [];
  const conversationState = getConversationState(user);
  const consentState = getConsentState({ user, history }) || "unknown";
  return {
    recentConversation: buildRecentConversation(history),
    conversationState,
    knownCustomerFacts: conversationState.agentFacts,
    consentState,
    // Scenario-authored, not re-derived via agentShadow.js's narrower
    // name-request-only deriveOpenQuestion heuristic: these scenarios assert
    // "the Agent is given this exact open question," the same pattern
    // src/agentScenarios.js's own B04 scenario already uses directly.
    currentOpenQuestion: scenario.lastTurnResponse || null
  };
}

// Benchmark-only safety net: this environment's network path to OpenRouter
// was confirmed unreachable (fetch failed, confirmed both sandboxed and
// unsandboxed), but a dropped TCP SYN through a blocking proxy can leave
// Node's fetch() hanging for the OS-level connect timeout (observed: tens of
// minutes across a full scenario set) rather than failing fast. This wraps
// the call with a short logical timeout so the BENCHMARK can proceed and
// report "infrastructure_error" promptly — it does not touch
// agentDecision.js's real defaultCallModel/decideNextStep, and does not
// change what a real caller with working network would experience.
const BENCHMARK_CALL_TIMEOUT_MS = Number(process.env.BENCHMARK_CALL_TIMEOUT_MS || 8000);
function withTimeout(promise, ms, onTimeoutValue) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeoutValue), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- CLI / env config ---------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-zA-Z]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function resolveConfig() {
  const args = parseArgs(process.argv.slice(2));
  const runs = Number(args.runs || process.env.BENCHMARK_RUNS || 3) || 3;
  const locale = args.locale || process.env.BENCHMARK_LOCALE || null;
  const scenarioId = args.scenario || process.env.BENCHMARK_SCENARIO || null;
  const output = args.output || process.env.BENCHMARK_OUTPUT || path.join(ROOT, "artifacts", "refal-agent-benchmark.json");
  return { runs, locale, scenarioId, output };
}

// --- shared fakes --------------------------------------------------------------

function integrationStore(user) {
  const calls = user.workflowCalls || (user.workflowCalls = []);
  return {
    ensureUser: async () => user,
    getUser: async () => user,
    updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response, extra) => { const turn = { message, response, metadata: extra?.metadata || {} }; user.history.push(turn); return turn; },
    saveQualification: async (...a) => calls.push(["qualification", ...a]),
    saveIntents: async (...a) => calls.push(["intents", ...a]),
    saveConsent: async (...a) => calls.push(["consent", ...a]),
    createHandover: async (...a) => { calls.push(["handover", ...a]); return { id: "bench-handover" }; },
    createNotification: async (...a) => { calls.push(["notification", ...a]); return { id: "bench-notification" }; },
    createPriorityAlert: async (...a) => calls.push(["priority", ...a]),
    createComplaint: async (...a) => calls.push(["complaint", ...a]),
    saveExistingClientVerification: async (...a) => calls.push(["existing_client", ...a])
  };
}

function bookingStoreFor(user) {
  const appointment = { id: `bench-appt-${user.id}`, status: "pending_review", created_at: BOOKING_NOW.toISOString() };
  return {
    ensureUser: async () => user,
    getBookingPolicy: async () => BOOKING_POLICY,
    updateUser: async (_id, update) => { update(user); return user; },
    createAppointment: async (value) => { Object.assign(appointment, { starts_at: value.startsAt, ends_at: value.endsAt }); return { appointment }; },
    updateAppointment: async (id, patch) => Object.assign(appointment, patch),
    createReminder: async () => {}
  };
}

function buildUser(scenario, idPrefix) {
  // REFAL-AGENT-029: a plausible customer name (same placeholder
  // src/agentScenarios.js's own makeBookingUser() already uses), so
  // requestBookingAction's normalizeAppointmentDetails never fails closed on
  // MISSING_APPOINTMENT_DETAILS (name) for every booking scenario regardless
  // of what the real model decides — a missing fixture field must never look
  // like "the booking tool doesn't work" or "the model chose wrong". No other
  // tool reads profile.name (confirmed by source inspection), so this is
  // inert everywhere except the booking write path.
  const user = { id: `${idPrefix}-${scenario.id}`, profile: { name: "Test" }, history: (scenario.history || []).map((h) => ({ ...h })) };
  // REFAL-AGENT-029: no synthetic customer-side filler message — a bare
  // `response` entry with no `message` contributes only the real prior
  // ASSISTANT turn to recentConversation (src/agentShadow.js's
  // buildRecentConversation skips a turn's user/assistant half whenever that
  // half's text is empty), instead of putting a literal "(prior turn)" string
  // into the real model's conversation history as if the customer had said it.
  if (scenario.lastTurnResponse) user.history.push({ message: "", response: scenario.lastTurnResponse });
  if (scenario.seedFacts) {
    user.profile.agentFacts = Object.fromEntries(Object.entries(scenario.seedFacts).map(([k, v]) => [k, { value: v, provenance: "customer_message", savedAt: new Date().toISOString() }]));
  }
  return user;
}

function ragFixtureStore(scenario) {
  if (scenario.forceRagError) return { searchKnowledge: async () => { throw new Error("edge function unreachable"); } };
  if (scenario.id === "A03") return { searchKnowledge: async () => [] }; // no_evidence
  return { searchKnowledge: async () => [{ heading: "Approved the business information", content: "Company formation, accounting, and tax filing services are published; company formation is EUR 1500." }] };
}

function classifyFallbackReason(outcome) {
  if (outcome === "decision_failed" || outcome === "invalid_decision") return "model_decision_failure";
  if (outcome === "response_rejected" || outcome === "clarify_rejected") return "response_policy_rejection";
  if (outcome === "max_steps_reached") return "step_budget";
  return "other";
}

function emptyMetrics() {
  return { currentRequestAnswered: null, unnecessaryQuestion: null, unnecessaryToolCall: null, fallbackUsed: null, fallbackReason: null, rejectionReasonCodes: [], languageMismatch: null, stepCount: null, maxSteps: null, toolsUsed: [], ragStatus: null, toolFailure: null, unsafeDraftBlocked: null, unsafeFinalResponse: null, clarificationNecessary: null, evaluatorReasonCode: null, bookingToolInvoked: null };
}

// --- Agent arm -------------------------------------------------------------------

async function runAgentScenario(scenario, runIndex, callStats) {
  // agentDecision.js's real decideNextStep NEVER throws — a model/network
  // failure is caught INSIDE it and returned as a normal (but invalid)
  // decision object ({invalid:true, reason:"model_call_failed:..."}), which
  // agentLoop.js's validateDecision then rejects for a DIFFERENT reason
  // ("missing_response_text"). That original infra-failure reason is lost by
  // the time runAgentTurn returns its result — so it must be captured HERE,
  // at the actual call site, not inferred after the fact from result.outcome.
  const turnInfra = { anyInfraFailure: false, reasons: [] };
  const decide = (args) => { callStats.total += 1; return withTimeout(realDecideNextStep(args), BENCHMARK_CALL_TIMEOUT_MS, { type: "respond", text: null, invalid: true, reason: "model_call_failed:benchmark_timeout_exceeded" }).then((d) => {
    if (!d?.invalid) { callStats.success += 1; return d; }
    callStats.failed += 1;
    if (/^model_call_failed:/.test(d.reason || "")) { turnInfra.anyInfraFailure = true; turnInfra.reasons.push(d.reason); }
    return d;
  }); };
  const user = buildUser(scenario, "bench-agent");
  // REFAL-AGENT-029: real recentConversation/conversationState/consentState,
  // built the same way production's shadow path builds them (see
  // src/agentShadow.js's runShadowAgentTurn) — previously omitted entirely,
  // so memory/clarification/consent/topic-change scenarios ran the real
  // decision model with no conversational history at all.
  const scenarioContext = buildAgentScenarioContext(scenario, user);

  let result;
  if (scenario.category === "booking") {
    const toolContext = { store: bookingStoreFor(user), user, userId: user.id, policy: BOOKING_POLICY, now: BOOKING_NOW, inboundMessageId: `bench-agent-${scenario.id}-${runIndex}`, language: scenario.locale };
    const context = buildAgentContext({ currentMessage: scenario.message, locale: scenario.locale, ...scenarioContext });
    result = await withCalendarEnv({ busy: scenario.bookingBusy ? [SLOT] : [] }, () =>
      runAgentTurn(context, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext, maxSteps: DEFAULT_MAX_STEPS })
    );
  } else {
    result = await runAgentTurnForContact(
      { currentMessage: scenario.message, locale: scenario.locale, user, userId: user.id, store: ragFixtureStore(scenario), embedText: async () => null, ...scenarioContext },
      { decideNextStep: decide, maxSteps: DEFAULT_MAX_STEPS }
    );
  }

  const telemetry = summarizeAgentTurn(result);
  const languageSignal = languageSignalsFrom(scenario.locale, result.response);

  if (turnInfra.anyInfraFailure) {
    return { scenarioId: scenario.id, arm: "agent", runIndex, locale: scenario.locale, category: scenario.category, featureTags: scenario.featureTags, status: "infrastructure_error", infrastructureErrorKind: "network_or_provider", infrastructureErrorDetail: turnInfra.reasons[0], knownTicket: null, outcome: result.outcome, responsePreview: null, metrics: { ...emptyMetrics(), stepCount: telemetry.stepCount, maxSteps: DEFAULT_MAX_STEPS, toolsUsed: telemetry.toolsUsed } };
  }

  let evaluator = { evaluatorUnavailable: true, reason: "not_attempted" };
  if (typeof result.response === "string" && result.response.trim() && !telemetry.fallbackUsed) {
    evaluator = await judgeResponse({ customerMessage: scenario.message, locale: scenario.locale, response: result.response });
  }

  const unsafeDraftBlocked = unsafeDraftWasBlocked(result.outcome, telemetry.rejectionReasonCodes);
  const unsafeFinalResponse = finalResponseIsUnsafe(result.response);
  const answerMetrics = deriveAnswerMetrics(evaluator);

  return {
    scenarioId: scenario.id, arm: "agent", runIndex, locale: scenario.locale, category: scenario.category, featureTags: scenario.featureTags,
    status: "measured", infrastructureErrorKind: null, knownTicket: null, outcome: result.outcome,
    responsePreview: safeResponsePreview(result.response),
    metrics: {
      currentRequestAnswered: answerMetrics.currentRequestAnswered,
      unnecessaryQuestion: answerMetrics.unnecessaryQuestion,
      unnecessaryToolCall: null, // no reliable deterministic signal for "was this tool call necessary" without ground truth per scenario — left NOT_APPLICABLE rather than guessed
      fallbackUsed: telemetry.fallbackUsed,
      fallbackReason: telemetry.fallbackUsed ? classifyFallbackReason(result.outcome) : null,
      rejectionReasonCodes: telemetry.rejectionReasonCodes,
      languageMismatch: languageSignal.languageMismatch,
      stepCount: telemetry.stepCount, maxSteps: DEFAULT_MAX_STEPS,
      toolsUsed: telemetry.toolsUsed,
      ragStatus: telemetry.ragResultStatus,
      toolFailure: telemetry.toolCalls.some((c) => !c.ok),
      unsafeDraftBlocked,
      unsafeFinalResponse,
      clarificationNecessary: answerMetrics.clarificationNecessary,
      evaluatorReasonCode: answerMetrics.evaluatorReasonCode,
      bookingToolInvoked: bookingToolInvokedMetric(scenario.category, telemetry.toolsUsed)
    },
    evaluatorMeta: evaluator.evaluatorUnavailable ? { unavailable: true, reason: evaluator.reason } : { unavailable: false, promptVersion: evaluator.promptVersion, reasonCode: evaluator.reasonCode }
  };
}

// --- Legacy arm ------------------------------------------------------------------

// Pure copy of src/bot.js's own `removeCustomerCitations` (that file cannot
// be required here — benchmarkSafety.test.js forbids it, since requiring
// bot.js would transitively pull in the real WhatsApp/Supabase transport).
// This is a tiny, side-effect-free string transform; duplicating it is safe,
// requiring the module it lives in is not.
function stripSourceCitations(text) {
  return String(text || "")
    .replace(/\n\s*(?:sources?|المصادر)\s*:\s*[\s\S]*$/iu, "")
    .replace(/https?:\/\/\S+/giu, "")
    .trim();
}

const PRIVACY_REMINDER_BY_LANGUAGE = Object.freeze({
  arabic: "ولحماية خصوصيتك، لا تبعت كلمات مرور أو بيانات بطاقات أو دخول هون.",
  greek: "Για την προστασία του απορρήτου σας, μην στέλνετε κωδικούς πρόσβασης, στοιχεία κάρτας ή τραπεζικά στοιχεία εδώ.",
  english: "For your privacy, please don’t send passwords, card details, or account credentials here."
});

// REFAL-AGENT-029 — the legacy AI-routed path, matching src/bot.js's real
// behavior (evidence retrieval -> grounded/localRecap/no-evidence selection
// -> real askOpenRouter call -> citation stripping -> privacy reminder)
// exactly, so a scenario legacy routes to AI is actually measured instead of
// excluded. `callOpenRouter` is injectable so tests can verify this chain
// without a real network call; production always uses the real askOpenRouter.
async function runLegacyAiResponse(scenario, routed, { callOpenRouter = askOpenRouter } = {}) {
  const customerText = routed.metadata?.privacySafeQuestion || String(scenario.message || "").trim();
  let evidence = [];
  try {
    evidence = await ragFixtureStore(scenario).searchKnowledge(redactPersonalData(customerText), null, DEFAULT_EMBEDDING_MODEL, 6);
  } catch {
    evidence = []; // mirrors bot.js's own catch-and-continue on a knowledge-search failure
  }

  const allowPricing = routed.metadata?.intent?.intents?.includes("pricing") === true;
  const language = detectMessageLanguage(customerText);
  const grounded = answerFromEvidence(evidence, { allowPricing, customerQuestion: redactPersonalData(customerText) });
  const localRecap = buildLocalConversationRecap({
    history: routed.user?.history || [],
    evidence,
    currentMessage: customerText,
    language,
    workflowState: { handover: routed.user?.profile?.handover, specialistFollowUp: routed.user?.profile?.specialistFollowUp }
  });
  let response = localRecap?.response || grounded?.answer || noApprovedEvidenceReply(language, { pricing: allowPricing });

  let aiModelAttempted = false;
  let aiModelUsed = false;
  // Same guard bot.js uses: give the model the evidence bundle even when no
  // deterministic excerpt is safe to send; relevance only controls the local
  // fallback, never whether the model gets a chance to help.
  if (!localRecap && evidence.length) {
    aiModelAttempted = true;
    try {
      const conversation = buildConversationContext(routed.user, { currentMessage: customerText });
      const aiResponse = await withTimeout(
        callOpenRouter({ text: customerText, evidence, includeSources: false, conversationSummary: conversation.summary, conversationTurns: conversation.turns }),
        BENCHMARK_CALL_TIMEOUT_MS,
        null
      );
      if (aiResponse) { response = aiResponse; aiModelUsed = true; }
    } catch {
      // Mirrors bot.js's own silent fallback: keep the deterministic answer
      // already selected above (grounded/localRecap/no-evidence reply) — a
      // real customer is never shown an error, and neither is this harness.
    }
  }

  response = stripSourceCitations(response);
  if (routed.metadata?.privacySafeQuestion) {
    const reminder = PRIVACY_REMINDER_BY_LANGUAGE[language] || PRIVACY_REMINDER_BY_LANGUAGE.english;
    response = `${response} ${reminder}`.trim();
  }
  return { response, aiModelAttempted, aiModelUsed };
}

async function runLegacyScenario(scenario, runIndex, { callOpenRouter = askOpenRouter } = {}) {
  const user = buildUser(scenario, "bench-legacy");

  if (scenario.category === "booking") {
    const bookingResult = await withCalendarEnv({ busy: scenario.bookingBusy ? [SLOT] : [] }, () =>
      handleBookingMessage({ userId: user.id, text: scenario.message, store: bookingStoreFor(user), now: BOOKING_NOW })
    );
    if (bookingResult) return scoreLegacyResponse(scenario, runIndex, bookingResult.response, null);
    // falls through to the deterministic router exactly as bot.js does when handleBookingMessage declines
  }

  const routed = await routeMessageResult({ userId: user.id, text: scenario.message, store: integrationStore(user), existingUser: user });
  if (routed.shouldUseAi) {
    // REFAL-AGENT-029: previously this entire branch returned status
    // "not_measurable" for EVERY AI-routed scenario, regardless of whether a
    // real model call was actually possible — silently excluding a biased
    // subset (every information/RAG scenario) from the legacy baseline. Now
    // measured for real, the same way the Agent arm already is.
    const { response, aiModelAttempted, aiModelUsed } = await runLegacyAiResponse(scenario, routed, { callOpenRouter });
    return scoreLegacyResponse(scenario, runIndex, response, routed.metadata, { aiModelAttempted, aiModelUsed });
  }
  return scoreLegacyResponse(scenario, runIndex, routed.response, routed.metadata);
}

async function scoreLegacyResponse(scenario, runIndex, response, metadata, aiMeta = {}) {
  const languageSignal = languageSignalsFrom(scenario.locale, response);
  let evaluator = { evaluatorUnavailable: true, reason: "not_attempted" };
  if (typeof response === "string" && response.trim()) {
    evaluator = await withTimeout(judgeResponse({ customerMessage: scenario.message, locale: scenario.locale, response }), BENCHMARK_CALL_TIMEOUT_MS, { evaluatorUnavailable: true, reason: "model_call_failed:benchmark_timeout_exceeded" });
  }
  let knownTicket = null;
  if (scenario.knownTicketCandidate?.arm === "legacy" && metadata?.safety?.risks?.includes?.(SAFETY_CATEGORIES.PRIVACY)) {
    knownTicket = scenario.knownTicketCandidate.ticket;
  } else if (scenario.knownTicketCandidate?.arm === "legacy") {
    // Independently re-check with classifySafety directly in case metadata
    // doesn't carry the flag through this response shape — never silently
    // assume the bug fired just because the scenario COULD trigger it.
    const risk = classifySafety(scenario.message).risks.includes(SAFETY_CATEGORIES.PRIVACY);
    if (risk) knownTicket = scenario.knownTicketCandidate.ticket;
  }
  const answerMetrics = deriveAnswerMetrics(evaluator);
  return {
    scenarioId: scenario.id, arm: "legacy", runIndex, locale: scenario.locale, category: scenario.category, featureTags: scenario.featureTags,
    status: "measured", infrastructureErrorKind: null, knownTicket, outcome: "responded",
    responsePreview: safeResponsePreview(response),
    // null (NOT_APPLICABLE) for every scenario that never reaches the AI
    // branch at all (deterministic router / booking) — never a fabricated
    // false. See runLegacyAiResponse for how these are actually measured.
    aiModelAttempted: aiMeta.aiModelAttempted ?? null,
    aiModelUsed: aiMeta.aiModelUsed ?? null,
    metrics: {
      currentRequestAnswered: answerMetrics.currentRequestAnswered,
      unnecessaryQuestion: answerMetrics.unnecessaryQuestion,
      unnecessaryToolCall: null,
      fallbackUsed: null, // the legacy deterministic router has no single "fallbackUsed" telemetry flag analogous to agentLoop.js's FALLBACK_OUTCOMES
      fallbackReason: null,
      rejectionReasonCodes: [],
      languageMismatch: languageSignal.languageMismatch,
      stepCount: null, maxSteps: null,
      toolsUsed: [],
      ragStatus: null,
      toolFailure: null,
      unsafeDraftBlocked: null, // the legacy benchmark harness has no draft/rejection telemetry to measure separately (it only ever sees the final routed response)
      unsafeFinalResponse: finalResponseIsUnsafe(response), // measured directly against the actual response text this harness returns, not inferred from the fact that recordHistory's own gate exists upstream in production
      clarificationNecessary: answerMetrics.clarificationNecessary,
      evaluatorReasonCode: answerMetrics.evaluatorReasonCode,
      bookingToolInvoked: null // legacy never calls the Agent tool registry
    }
  };
}

// --- main ------------------------------------------------------------------------

function gitInfo() {
  try {
    return { branch: execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT }).toString().trim(), commit: execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim() };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

function readinessFrom(legacyAgg, agentAgg) {
  const evidence = [];
  let category = "READY_FOR_ARCHITECTURE_REVIEW";
  const agentInfraRate = agentAgg.totals.total ? agentAgg.totals.infrastructureErrors / agentAgg.totals.total : 0;
  if (agentInfraRate >= 0.5) {
    category = "NOT_READY";
    evidence.push(`${(agentInfraRate * 100).toFixed(0)}% of Agent-arm turns (${agentAgg.totals.infrastructureErrors}/${agentAgg.totals.total}) ended in infrastructure_error (model/network unreachable in this environment) — real Agent decision quality could not be measured at all, so readiness cannot be assessed from this run.`);
  }
  // Gates on the FINAL delivered response only — a drafted claim that the
  // deterministic response policy rejected before it ever became
  // `result.response` never reached a customer and must not fail readiness
  // on its own (see the 2026-10-06 G03 audit). `unsafeDraftBlockedRate` is
  // still surfaced below, non-gating, because the safety net firing often is
  // itself useful signal about decision-prompt quality.
  if (agentAgg.metrics.unsafeFinalResponseRate.rate !== null && agentAgg.metrics.unsafeFinalResponseRate.rate > 0) {
    category = "NOT_READY";
    evidence.push(`Agent unsafe FINAL-RESPONSE rate: ${(agentAgg.metrics.unsafeFinalResponseRate.rate * 100).toFixed(1)}% — an unverified booking/handover claim actually present in the delivered response is disqualifying.`);
  }
  if (agentAgg.metrics.unsafeDraftBlockedRate.rate !== null && agentAgg.metrics.unsafeDraftBlockedRate.rate > 0) {
    evidence.push(`Agent unsafe-DRAFT-blocked rate: ${(agentAgg.metrics.unsafeDraftBlockedRate.rate * 100).toFixed(1)}% — the deterministic response policy correctly rejected these before delivery (not disqualifying on its own; informational — a high rate may still indicate a decision-prompt quality issue worth investigating separately).`);
  }
  if (agentAgg.metrics.languageMismatchRate.rate !== null && agentAgg.metrics.languageMismatchRate.rate > 0.1) {
    category = category === "READY_FOR_ARCHITECTURE_REVIEW" ? "NEEDS_TARGETED_FIXES" : category;
    evidence.push(`Agent language-mismatch rate: ${(agentAgg.metrics.languageMismatchRate.rate * 100).toFixed(1)}%.`);
  }
  if (agentAgg.totals.measured === 0) {
    evidence.push("Zero Agent-arm turns were measurable for behavioral quality in this run — see Cost report / infrastructure note.");
  }
  if (evidence.length === 0) evidence.push("No disqualifying signal found in this run, but see the measured/not-measurable counts before treating this as a strong result.");
  return { category, evidence };
}

async function main() {
  const config = resolveConfig();
  let scenarios = BENCHMARK_SCENARIOS;
  if (config.locale) scenarios = scenarios.filter((s) => s.locale === config.locale || s.locale.startsWith(config.locale));
  if (config.scenarioId) scenarios = scenarios.filter((s) => s.id === config.scenarioId || s.sourceId === config.scenarioId);
  if (scenarios.length === 0) throw new Error(`No scenarios matched locale=${config.locale} scenario=${config.scenarioId}`);

  const callStats = { total: 0, success: 0, failed: 0 };
  const legacyTurns = [];
  const agentTurns = [];

  for (const scenario of scenarios) {
    for (let run = 0; run < config.runs; run += 1) {
      legacyTurns.push(await runLegacyScenario(scenario, run));
      agentTurns.push(await runAgentScenario(scenario, run, callStats));
    }
  }

  const legacyAgg = aggregateScenarios(legacyTurns);
  const agentAgg = aggregateScenarios(agentTurns);
  const legacyExcluding = aggregateExcludingKnownTickets(legacyTurns);
  const agentExcluding = aggregateExcludingKnownTickets(agentTurns);

  const { branch, commit } = gitInfo();
  const environment = {
    date: new Date().toISOString(),
    branch, commit,
    model: resolveOpenRouterModel(process.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL),
    evaluatorModel: process.env.BENCHMARK_EVALUATOR_MODEL || DEFAULT_OPENROUTER_MODEL,
    provider: "openrouter",
    scenarioCount: scenarios.length,
    runsPerScenario: config.runs,
    maxSteps: DEFAULT_MAX_STEPS,
    note: callStats.total > 0 && callStats.success === 0
      ? "Every Agent decision model call failed in this environment (see Cost report). Agent-arm behavioral metrics below are NOT a measure of Agent quality — see the CHANGE TICKET for the infrastructure explanation."
      : null
  };

  // REFAL-AGENT-029: the legacy arm now makes real OpenRouter calls too (see
  // runLegacyAiResponse) — tracked per-turn via aiModelAttempted/aiModelUsed
  // rather than a shared mutable counter, since runLegacyScenario calls are
  // independent (no decision-loop retry state to thread through).
  const legacyAiAttempted = legacyTurns.filter((t) => t.aiModelAttempted === true);
  const legacyAiSucceeded = legacyAiAttempted.filter((t) => t.aiModelUsed === true);
  const bookingAgentTurns = agentTurns.filter((t) => t.category === "booking" && t.status === "measured");
  const bookingToolExecutions = bookingAgentTurns.filter((t) => t.metrics.bookingToolInvoked === true);

  const cost = {
    totalCalls: callStats.total, successfulCalls: callStats.success, failedCalls: callStats.failed,
    avgCallsPerScenario: scenarios.length ? callStats.total / scenarios.length : 0,
    totalSteps: agentTurns.reduce((sum, t) => sum + (t.metrics.stepCount || 0), 0),
    retries: 0, // agentDecision.js's decideNextStep has no retry policy today — a failed call becomes a fallback decision immediately (confirmed by source inspection)
    tokenUsageAvailable: false, promptTokens: 0, completionTokens: 0,
    costAvailable: false, costUsd: 0,
    legacyAiCallsAttempted: legacyAiAttempted.length,
    legacyAiCallsSucceeded: legacyAiSucceeded.length,
    bookingScenarioTurnsMeasured: bookingAgentTurns.length,
    bookingToolExecutions: bookingToolExecutions.length
  };

  const readiness = readinessFrom(legacyAgg, agentAgg);

  const historical = "Ticket 012's trace recorded a project-measured ~15% draft-rejection rate on the pre-refactor single-shot model path becoming a generic fallback (docs/refal-agent-refactor-progress.md, REFAL-AGENT-012). No comparable per-scenario dataset from that measurement survives in the repo to recompute alongside this benchmark.";

  const reportMarkdown = buildReportMarkdown({ environment, legacy: legacyAgg, agent: agentAgg, legacyExcluding, agentExcluding, historical, cost, readiness });

  const artifact = { environment, cost, readiness, legacyTurns, agentTurns, legacyAggregate: legacyAgg, agentAggregate: agentAgg, legacyAggregateExcludingKnownTickets: legacyExcluding, agentAggregateExcludingKnownTickets: agentExcluding, evaluatorPromptVersion: EVALUATOR_PROMPT_VERSION };

  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  fs.writeFileSync(config.output, JSON.stringify(artifact, null, 2), "utf8");
  const reportPath = path.join(ROOT, "docs", "refal-agent-benchmark.md");
  fs.writeFileSync(reportPath, reportMarkdown, "utf8");

  console.log(`Wrote ${config.output}`);
  console.log(`Wrote ${reportPath}`);
  console.log(`Scenarios: ${scenarios.length}, runs/scenario: ${config.runs}`);
  console.log(`Agent decision calls: ${callStats.total} (success=${callStats.success}, failed=${callStats.failed})`);
  console.log(`Legacy AI calls: ${legacyAiAttempted.length} attempted, ${legacyAiSucceeded.length} succeeded`);
  console.log(`Booking tool executions: ${bookingToolExecutions.length}/${bookingAgentTurns.length} measured booking turns`);
  console.log(`Readiness: ${readiness.category}`);
}

module.exports = {
  resolveConfig, integrationStore, bookingStoreFor, buildUser, runAgentScenario, runLegacyScenario, runLegacyAiResponse,
  readinessFrom, gitInfo, unsafeDraftWasBlocked, finalResponseIsUnsafe, deriveAnswerMetrics, bookingToolInvokedMetric,
  safeResponsePreview, buildAgentScenarioContext, stripSourceCitations
};

if (require.main === module) {
  // withTimeout above logically moves on without cancelling the underlying
  // fetch (undici has no clean abort path threaded through here) — an
  // abandoned, still-pending connection attempt would otherwise keep the
  // event loop alive well past the benchmark's own reported completion.
  // Explicit exit only in the CLI entry point, never in the exported
  // functions the test suite imports.
  main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
