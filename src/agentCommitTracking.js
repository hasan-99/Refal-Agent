// REFAL-AGENT-031 — turn-level commit tracking for the Agent's real
// side-effecting tools.
//
// This is the ONLY source of truth for "did this turn already commit a real
// booking/handover write" — never the model's own response text, never a
// tool call's mere presence/intent (a "tool" decision the model made that
// the deterministic tool layer then REJECTED is NOT a commit), only an
// actual resolved, successful result FROM THE REAL TOOL ITSELF.
//
// Why this matters: once a write has actually happened (e.g. a real
// appointment row), re-running the turn through legacy as a "failure
// fallback" (see turnRouting.js, REFAL-AGENT-030) could repeat that action a
// second time. This module lets the live Agent turn tell "failed before
// anything happened" (safe to retry via legacy) apart from "failed after a
// real write" (never retry; answer from the write's own result instead).

// Explicit allowlist, mirroring the "default-deny" discipline agentShadow.js
// already uses for reads (READ_ONLY_TOOLS), but for commits: a tool name not
// listed here, or a listed tool's result status that isn't one of these
// exact strings, NEVER marks a commit — including any `fail(...)` result,
// which agentToolResult.js always shapes as `{ ok: false, ... }`.
const COMMITTING_TOOL_STATUSES = Object.freeze({
  // agentBookingTools.js's requestBookingAction: both "confirmed" and
  // "pending_review" mean a real, durable appointment row was created (see
  // that file's own comments) — its only two success statuses.
  requestBookingAction: new Set(["confirmed", "pending_review"]),
  // No tool in agentTools.js's TOOL_REGISTRY persists a handover today —
  // proposeHandover is authorization-only by design (see its own file
  // comment: persistence deliberately stays on messageRouter.js's existing
  // recordHistory -> store.createHandover path, so this does not open a
  // second, less-audited write path). Listed here so a future real
  // persisting-handover tool is covered by this exact mechanism the moment
  // it is registered under this name, with zero changes to this file.
  commitHandover: new Set(["persisted"])
});

const CLEAN_SUCCESS_OUTCOMES = new Set(["responded", "clarified"]);

function createCommitState() {
  return { sideEffectCommitted: false, committedActions: [] };
}

// Wraps a tool registry so that after the REAL tool.run resolves, a listed
// tool name + a listed success status moves `commitState` to committed.
// Reads only `result.ok`/`result.status`/`result.data`/`result.userSafeSummary`
// — values the tool itself computed — never the model's decision JSON, and
// never anything from `args` (a model-authored tool call "intent" can never
// set this on its own).
function buildCommitTrackingToolRegistry(tools, commitState) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const successStatuses = COMMITTING_TOOL_STATUSES[name];
      if (!successStatuses) return [name, tool];
      return [name, {
        ...tool,
        run: async (args, toolContext) => {
          const result = await tool.run(args, toolContext);
          if (result?.ok === true && successStatuses.has(result.status)) {
            commitState.sideEffectCommitted = true;
            commitState.committedActions.push({
              tool: name,
              status: result.status,
              data: result.data || null,
              userSafeSummary: result.userSafeSummary || null
            });
          }
          return result;
        }
      }];
    })
  );
}

// runAgentTurn (agentLoop.js) never throws for an ordinary bad decision/
// tool/policy outcome — every one of those already resolves with a safe
// fallback-text response. Only "responded"/"clarified" are a validated,
// model-authored answer; every other outcome is a deterministic internal
// fallback standing in for a failed draft.
function isCleanSuccess(result) {
  return Boolean(result) && CLEAN_SUCCESS_OUTCOMES.has(result.outcome);
}

function languageKey(locale) {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("ar")) return "ar";
  if (value.startsWith("el") || value.startsWith("greek")) return "el";
  return "en";
}

// Deterministic, localized, never model-authored. Used only when a real
// write succeeded but the tool itself didn't already provide its own
// customer-facing summary (agentBookingTools.js's "pending_review" status
// does not — only "confirmed" does, via bookingConfirmationMessage).
const PENDING_REVIEW_TEXT = {
  en: "Your appointment request has been submitted and is awaiting confirmation from our team.",
  ar: "تم إرسال طلب موعدك وهو الآن قيد مراجعة فريقنا لتأكيده.",
  el: "Το αίτημά σας για ραντεβού υποβλήθηκε και αναμένει επιβεβαίωση από την ομάδα μας."
};

const HANDOVER_COMMITTED_TEXT = {
  en: "I've passed this along to a specialist on our team, who will follow up with you.",
  ar: "حوّلت طلبك إلى مختص بفريقنا، وح يتواصل معك قريبًا.",
  el: "Προώθησα το αίτημά σας σε έναν ειδικό της ομάδας μας, ο οποίος θα επικοινωνήσει μαζί σας."
};

// Never reads the Agent's own (failed/rejected) draft text. Built only from
// the last committed action's own deterministic result.
function safeResponseForCommittedAction(commitState, locale) {
  const last = commitState?.committedActions?.[commitState.committedActions.length - 1];
  if (!last) return null;
  if (last.userSafeSummary) return last.userSafeSummary;
  const lang = languageKey(locale);
  if (last.tool === "commitHandover") return HANDOVER_COMMITTED_TEXT[lang];
  return PENDING_REVIEW_TEXT[lang];
}

// The one decision point this ticket adds on top of a resolved Agent turn:
// send the clean result, send a safe deterministic committed-action
// response, or signal that a legacy fallback is still safe. Pure — takes
// the already-resolved `result`/`commitState`, performs no IO, so it is
// fully unit-testable without bot.js or a live Baileys socket.
function decideAgentTurnOutcome({ result, commitState, locale } = {}) {
  if (isCleanSuccess(result)) return { send: true, responseText: result.response };
  if (commitState?.sideEffectCommitted) {
    return { send: true, responseText: safeResponseForCommittedAction(commitState, locale) || result?.response || null };
  }
  // Nothing was committed yet — always pre-side-effect-safe for
  // turnRouting.js's runRoutedTurn to catch and re-run legacy for.
  return { send: false, fallbackToLegacy: true, reason: `agent_turn_not_clean:${result?.outcome}` };
}

module.exports = {
  createCommitState,
  buildCommitTrackingToolRegistry,
  isCleanSuccess,
  safeResponseForCommittedAction,
  decideAgentTurnOutcome,
  COMMITTING_TOOL_STATUSES,
  CLEAN_SUCCESS_OUTCOMES
};
