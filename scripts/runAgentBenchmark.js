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
const { decideNextStep: realDecideNextStep } = require("../src/agentDecision");
const { TOOL_REGISTRY } = require("../src/agentTools");
const { summarizeAgentTurn, languageSignalsFrom } = require("../src/agentObservability");
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
  const user = { id: `${idPrefix}-${scenario.id}`, profile: {}, history: (scenario.history || []).map((h) => ({ ...h })) };
  if (scenario.lastTurnResponse) user.history.push({ message: "(prior turn)", response: scenario.lastTurnResponse });
  if (scenario.seedFacts) {
    user.profile.agentFacts = Object.fromEntries(Object.entries(scenario.seedFacts).map(([k, v]) => [k, { value: v, provenance: "customer_message", savedAt: new Date().toISOString() }]));
  }
  return user;
}

function ragFixtureStore(scenario) {
  if (scenario.forceRagError) return { searchKnowledge: async () => { throw new Error("edge function unreachable"); } };
  if (scenario.id === "A03") return { searchKnowledge: async () => [] }; // no_evidence
  return { searchKnowledge: async () => [{ heading: "Approved Refalco information", content: "Company formation, accounting, and tax filing services are published; company formation is EUR 1500." }] };
}

function classifyFallbackReason(outcome) {
  if (outcome === "decision_failed" || outcome === "invalid_decision") return "model_decision_failure";
  if (outcome === "response_rejected" || outcome === "clarify_rejected") return "response_policy_rejection";
  if (outcome === "max_steps_reached") return "step_budget";
  return "other";
}

function emptyMetrics() {
  return { currentRequestAnswered: null, unnecessaryQuestion: null, unnecessaryToolCall: null, fallbackUsed: null, fallbackReason: null, rejectionReasonCodes: [], languageMismatch: null, stepCount: null, maxSteps: null, toolsUsed: [], ragStatus: null, toolFailure: null, unsafeDraftBlocked: null, unsafeFinalResponse: null };
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

  let result;
  if (scenario.category === "booking") {
    const toolContext = { store: bookingStoreFor(user), user, userId: user.id, policy: BOOKING_POLICY, now: BOOKING_NOW, inboundMessageId: `bench-agent-${scenario.id}-${runIndex}`, language: scenario.locale };
    result = await withCalendarEnv({ busy: scenario.bookingBusy ? [SLOT] : [] }, () =>
      runAgentTurn({ currentMessage: scenario.message, locale: scenario.locale }, { decideNextStep: decide, tools: TOOL_REGISTRY, toolContext, maxSteps: DEFAULT_MAX_STEPS })
    );
  } else {
    result = await runAgentTurnForContact(
      { currentMessage: scenario.message, locale: scenario.locale, user, userId: user.id, store: ragFixtureStore(scenario), embedText: async () => null, currentOpenQuestion: scenario.lastTurnResponse || null },
      { decideNextStep: decide, maxSteps: DEFAULT_MAX_STEPS }
    );
  }

  const telemetry = summarizeAgentTurn(result);
  const languageSignal = languageSignalsFrom(scenario.locale, result.response);

  if (turnInfra.anyInfraFailure) {
    return { scenarioId: scenario.id, arm: "agent", runIndex, locale: scenario.locale, category: scenario.category, featureTags: scenario.featureTags, status: "infrastructure_error", infrastructureErrorKind: "network_or_provider", infrastructureErrorDetail: turnInfra.reasons[0], knownTicket: null, outcome: result.outcome, metrics: { ...emptyMetrics(), stepCount: telemetry.stepCount, maxSteps: DEFAULT_MAX_STEPS, toolsUsed: telemetry.toolsUsed } };
  }

  let evaluator = { evaluatorUnavailable: true, reason: "not_attempted" };
  if (typeof result.response === "string" && result.response.trim() && !telemetry.fallbackUsed) {
    evaluator = await judgeResponse({ customerMessage: scenario.message, locale: scenario.locale, response: result.response });
  }

  const unsafeDraftBlocked = unsafeDraftWasBlocked(result.outcome, telemetry.rejectionReasonCodes);
  const unsafeFinalResponse = finalResponseIsUnsafe(result.response);

  return {
    scenarioId: scenario.id, arm: "agent", runIndex, locale: scenario.locale, category: scenario.category, featureTags: scenario.featureTags,
    status: "measured", infrastructureErrorKind: null, knownTicket: null, outcome: result.outcome,
    metrics: {
      currentRequestAnswered: evaluator.evaluatorUnavailable ? null : evaluator.currentRequestAnswered,
      unnecessaryQuestion: evaluator.evaluatorUnavailable ? null : evaluator.unnecessaryQuestion,
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
      unsafeFinalResponse
    },
    evaluatorMeta: evaluator.evaluatorUnavailable ? { unavailable: true, reason: evaluator.reason } : { unavailable: false, promptVersion: evaluator.promptVersion, reasonCode: evaluator.reasonCode }
  };
}

// --- Legacy arm ------------------------------------------------------------------

async function runLegacyScenario(scenario, runIndex) {
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
    return { scenarioId: scenario.id, arm: "legacy", runIndex, locale: scenario.locale, category: scenario.category, featureTags: scenario.featureTags, status: "not_measurable", notMeasurableReason: "legacy routes this to the AI/RAG path (bot.js calling askOpenRouter), which requires live model/network access outside this safe harness — not faked, per the ticket's explicit instruction", knownTicket: null, outcome: "routes_to_ai", metrics: emptyMetrics() };
  }
  return scoreLegacyResponse(scenario, runIndex, routed.response, routed.metadata);
}

async function scoreLegacyResponse(scenario, runIndex, response, metadata) {
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
  return {
    scenarioId: scenario.id, arm: "legacy", runIndex, locale: scenario.locale, category: scenario.category, featureTags: scenario.featureTags,
    status: "measured", infrastructureErrorKind: null, knownTicket, outcome: "responded",
    metrics: {
      currentRequestAnswered: evaluator.evaluatorUnavailable ? null : evaluator.currentRequestAnswered,
      unnecessaryQuestion: evaluator.evaluatorUnavailable ? null : evaluator.unnecessaryQuestion,
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
      unsafeFinalResponse: finalResponseIsUnsafe(response) // measured directly against the actual response text this harness returns, not inferred from the fact that recordHistory's own gate exists upstream in production
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

  const cost = {
    totalCalls: callStats.total, successfulCalls: callStats.success, failedCalls: callStats.failed,
    avgCallsPerScenario: scenarios.length ? callStats.total / scenarios.length : 0,
    totalSteps: agentTurns.reduce((sum, t) => sum + (t.metrics.stepCount || 0), 0),
    retries: 0, // agentDecision.js's decideNextStep has no retry policy today — a failed call becomes a fallback decision immediately (confirmed by source inspection)
    tokenUsageAvailable: false, promptTokens: 0, completionTokens: 0,
    costAvailable: false, costUsd: 0
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
  console.log(`Readiness: ${readiness.category}`);
}

module.exports = { resolveConfig, integrationStore, bookingStoreFor, runAgentScenario, runLegacyScenario, readinessFrom, gitInfo, unsafeDraftWasBlocked, finalResponseIsUnsafe };

if (require.main === module) {
  // withTimeout above logically moves on without cancelling the underlying
  // fetch (undici has no clean abort path threaded through here) — an
  // abandoned, still-pending connection attempt would otherwise keep the
  // event loop alive well past the benchmark's own reported completion.
  // Explicit exit only in the CLI entry point, never in the exported
  // functions the test suite imports.
  main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
