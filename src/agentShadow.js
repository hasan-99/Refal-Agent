// REFAL-AGENT-010 — bot.js shadow integration.
//
// Runs one real Agent turn (Tickets 001-009: real tool registry, real model
// decision, real RAG/handover/booking tools) ALONGSIDE the live deterministic
// path, purely for logging/comparison. This is explicitly NOT the cutover
// (Ticket 017): no caller may use this module's result to decide what a
// customer sees.
//
// Safety rails, each independent of the others:
//
//   1. Gated behind REFAL_AGENT_SHADOW_ENABLED (default off) — a fully
//      synchronous no-op when unset, so this ticket ships with zero
//      behavior/cost change until someone deliberately opts in.
//   2. DEFAULT-DENY tool execution: only the tools on the explicit
//      READ_ONLY_TOOLS allowlist below run for real. Every other tool name —
//      including one added to TOOL_REGISTRY later and never revisited here —
//      gets the dry-run stand-in. A forgotten allowlist entry therefore
//      fails safe (no write), never fails open.
//   3. Bounded concurrency: REFAL_AGENT_SHADOW_MAX_CONCURRENCY (default 3)
//      caps how many shadow turns run at once process-wide. A burst of
//      inbound messages beyond that cap SKIPS the extra shadow turns
//      (logged, not queued) rather than piling up unbounded real model/RAG
//      calls or firing late against stale conversation context.
//   4. The caller (src/bot.js) never awaits or reads this function's return
//      value — it is fire-and-forget by construction, so a shadow turn
//      cannot alter `response`/`routed` on the live path no matter what it
//      does internally.
//   5. Logging never carries free-text customer/agent content — only
//      outcome/shape metadata (see emitTurnEvent below) — consistent with
//      how the rest of src/bot.js's logEvent call sites already avoid
//      logging raw message/response bodies, and on top of
//      operationalTelemetry.js's own key-based redaction.
//
// Expected load when enabled: each inbound message adds up to one extra
// OpenRouter decision call per agent step (max 4 steps) plus, if
// searchApprovedKnowledge is chosen, one extra local-embedding + Supabase
// knowledge-search round trip — bounded at any instant by the concurrency
// cap above. That is a real, non-trivial increase in per-message cost and
// local CPU (the embedding pipeline runs in-process); it is why the flag
// defaults off and should only be enabled for a bounded comparison window,
// not left on by default in production.
//
// Testing note: this module has its own dedicated unit/integration tests
// (agentShadow.test.js). src/bot.js's one-line wiring (the `require` and the
// fire-and-forget call site) is NOT covered by an automated test — bot.js
// establishes a live Baileys socket connection as a side effect of being
// required, so it cannot be imported in this repo's test runner. That
// wiring was verified by code review only; see
// docs/refal-agent-refactor-progress.md's Ticket 010 entry.

const { randomUUID } = require("node:crypto");
const { runAgentTurnForContact } = require("./agentRuntime");
const { decideNextStep: defaultDecideNextStep } = require("./agentDecision");
const { TOOL_REGISTRY } = require("./agentTools");
const { getConversationState } = require("./conversationState");
const { getConsentState } = require("./leadQualification");
const { wasNameRequested } = require("./messageRouter");

const DEFAULT_MAX_CONCURRENCY = 3;

function shadowSkippedResult() {
  return { ok: true, status: "shadow_skipped", data: null, reasonCode: "SHADOW_MODE_NO_WRITE" };
}

// Explicit allowlist of tools independently confirmed read-only/non-
// persisting (see each tool's own file-level comment for the no-write
// guarantee this relies on): searchApprovedKnowledge (ai.js embedText +
// store.searchKnowledge, read-only), getCustomerContext (pure read of the
// already-loaded user object), getBookingAvailability (agentBookingTools.js:
// "Read-only, so no lock is needed"), proposeHandover (agentTools.js:
// "Authorization check only... never persists"). Anything not in this set —
// saveCustomerFact, requestBookingAction, and any tool added later — is
// treated as a write and dry-run by default. See safety rail #2 above.
const READ_ONLY_TOOLS = new Set([
  "searchApprovedKnowledge",
  "getCustomerContext",
  "getBookingAvailability",
  "proposeHandover"
]);

function buildShadowToolRegistry(tools = TOOL_REGISTRY) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => (
      READ_ONLY_TOOLS.has(name) ? [name, tool] : [name, { ...tool, run: async () => shadowSkippedResult() }]
    ))
  );
}

function isShadowEnabled(env = process.env) {
  return String(env.REFAL_AGENT_SHADOW_ENABLED || "false").toLowerCase() === "true";
}

function maxConcurrency(env = process.env) {
  const parsed = Number(env.REFAL_AGENT_SHADOW_MAX_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_CONCURRENCY;
}

// Process-wide (not per-user) by design: the risk being bounded is total
// concurrent real model/RAG calls this process makes, the same reasoning
// already documented for agentBookingTools.js's per-slot lock map and
// rateLimiter.js's in-memory counters — a second bot instance would not
// share this, which is fine, since each instance should independently stay
// under its own cost/load budget.
let activeShadowTurns = 0;

function buildRecentConversation(history = []) {
  const turns = [];
  for (const entry of Array.isArray(history) ? history.slice(-12) : []) {
    if (typeof entry?.message === "string" && entry.message.trim()) turns.push({ role: "user", content: entry.message });
    if (typeof entry?.response === "string" && entry.response.trim()) turns.push({ role: "assistant", content: entry.response });
  }
  return turns;
}

// Mirrors messageRouter.js's own open-question tracking (Phase 8 of the
// trace): re-derived from the bot's last rendered reply, never a separate
// stored flag. Only the one case already covered elsewhere (name request)
// is surfaced here — good enough for a shadow comparison signal, not a new
// source of truth.
function deriveOpenQuestion(lastTurn) {
  if (!lastTurn || !wasNameRequested(lastTurn)) return null;
  return String(lastTurn.response || "").slice(0, 300) || null;
}

// Deliberately NEVER includes the agent's drafted response text, the
// customer's message, or raw tool args — only shape/outcome metadata, so a
// legacy-vs-agent comparison pass can be done on outcome/step/tool-usage/
// timing without a new place in the codebase that logs free-text
// conversational content (every other src/bot.js logEvent call site already
// avoids this). responseLength (not the response itself) is enough to spot
// e.g. a shadow run producing suspiciously short/long answers relative to
// the legacy path's recorded turn, joinable by traceId.
function emitTurnEvent(emit, shadowTraceId, result, durationMs) {
  if (!emit) return;
  emit("agent_shadow_turn", {
    traceId: shadowTraceId,
    outcome: result.outcome,
    stepCount: result.stepCount,
    toolsUsed: result.toolsUsed,
    responseLength: typeof result.response === "string" ? result.response.length : 0,
    corrected: Boolean(result.corrected),
    reason: result.reason,
    durationMs
  });
}

async function runShadowAgentTurn({
  userId,
  text,
  user,
  store,
  classification,
  traceId,
  logEvent,
  embedText,
  embeddingModel,
  matchCount
} = {}, {
  tools = TOOL_REGISTRY,
  decideNextStep = defaultDecideNextStep,
  env = process.env
} = {}) {
  if (!isShadowEnabled(env)) return null;

  const shadowTraceId = traceId || randomUUID();
  const emit = typeof logEvent === "function" ? logEvent : null;

  const limit = maxConcurrency(env);
  if (activeShadowTurns >= limit) {
    if (emit) emit("agent_shadow_turn_skipped", { traceId: shadowTraceId, reasonCode: "CONCURRENCY_LIMIT", activeShadowTurns, limit });
    return null;
  }

  const startedAt = performance.now();
  activeShadowTurns += 1;
  try {
    const history = Array.isArray(user?.history) ? user.history : [];
    const lastTurn = history[history.length - 1] || null;
    const conversationState = getConversationState(user || {});
    const consentState = getConsentState({ user: user || {}, history }) || "unknown";

    const result = await runAgentTurnForContact(
      {
        currentMessage: text,
        locale: classification?.language || user?.profile?.language || "unknown",
        contact: { id: userId, name: user?.profile?.name || null },
        recentConversation: buildRecentConversation(history),
        conversationState,
        knownCustomerFacts: conversationState.agentFacts,
        currentOpenQuestion: deriveOpenQuestion(lastTurn),
        consentState,
        allowedCapabilities: [],
        store,
        user,
        userId,
        intents: classification?.intents || [],
        language: classification?.language,
        embedText,
        embeddingModel,
        matchCount
      },
      { tools: buildShadowToolRegistry(tools), decideNextStep }
    );

    const durationMs = Math.round(performance.now() - startedAt);
    emitTurnEvent(emit, shadowTraceId, result, durationMs);
    return { ...result, durationMs, traceId: shadowTraceId };
  } catch (error) {
    if (emit) {
      emit("agent_shadow_turn_error", {
        traceId: shadowTraceId,
        message: String(error?.message || error).slice(0, 200)
      });
    }
    return null;
  } finally {
    activeShadowTurns -= 1;
  }
}

// Test-only reset: activeShadowTurns is module-level process state (see the
// comment above it), so a test asserting on the concurrency gate must be
// able to start clean — same pattern as agentBookingTools.js's
// __resetBookingToolState.
function __resetShadowConcurrency() {
  activeShadowTurns = 0;
}

module.exports = {
  runShadowAgentTurn,
  isShadowEnabled,
  buildShadowToolRegistry,
  maxConcurrency,
  __resetShadowConcurrency
};
