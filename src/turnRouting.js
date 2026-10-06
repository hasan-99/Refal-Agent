// REFAL-AGENT-030 — the ONE live decision point for a customer turn: legacy
// path vs. Agent path. This module is deliberately pure/sync except for the
// one orchestration function below, which only ever calls the two callbacks
// it is handed (runLegacyTurn, runAgentTurn) — it never touches a socket,
// store, or anything beyond an env object, so it is fully unit-testable
// without opening a live Baileys connection.
//
// Rollback contract: REFAL_AGENT_LIVE_ENABLED defaults to unset/false, so
// selectTurnRoute always returns "legacy" until someone explicitly sets it to
// the literal string "true". Disabling it again immediately restores legacy
// routing — there is no other state to roll back (this ticket does not turn
// it on anywhere; see docs/refal-agent-refactor-progress.md REFAL-AGENT-017
// for the live cutover itself).
//
// Fallback contract: runAgentTurn (src/agentLoop.js's runAgentTurn, and the
// agentRuntime.js wrapper around it) never THROWS for an ordinary bad
// decision/tool/policy outcome — every one of those is already converted
// internally into a resolved `{ outcome, response }` result (a safe
// fallback-text response), so routing it to the customer is not a failure
// from this module's point of view. A throw out of runAgentTurn can only
// happen during turn SETUP, before any tool has had a chance to run — so
// catching it here and falling back to legacy is always pre-side-effect-safe
// by construction. A failure that happens AFTER a tool has already committed
// a side effect is explicitly out of scope here — see REFAL-AGENT-031.
function isAgentLiveEnabled(env = process.env) {
  return String(env.REFAL_AGENT_LIVE_ENABLED || "").trim().toLowerCase() === "true";
}

function selectTurnRoute(env = process.env) {
  return isAgentLiveEnabled(env) ? "agent" : "legacy";
}

// `params` is passed through verbatim to whichever callback runs — this
// function never reads or mutates it, so a caller-supplied field (e.g. the
// real inbound WhatsApp provider message id) always reaches runAgentTurn
// unchanged.
async function runRoutedTurn(params, { runLegacyTurn, runAgentTurn, env = process.env } = {}) {
  if (typeof runLegacyTurn !== "function") throw new Error("runRoutedTurn requires a runLegacyTurn function.");

  const route = selectTurnRoute(env);
  if (route !== "agent") {
    const result = await runLegacyTurn(params);
    return { ...result, route: "legacy" };
  }

  if (typeof runAgentTurn !== "function") throw new Error("runRoutedTurn requires a runAgentTurn function when the Agent route is selected.");

  try {
    const result = await runAgentTurn(params);
    return { ...result, route: "agent" };
  } catch (error) {
    // Pre-side-effect fallback only (see file header) — exactly one of
    // runAgentTurn/runLegacyTurn's result ends up returned here, so exactly
    // one routing path ever owns (and sends for) this turn.
    const result = await runLegacyTurn(params);
    return { ...result, route: "agent_fallback_legacy", fallbackReason: String(error?.message || error).slice(0, 200) };
  }
}

module.exports = { isAgentLiveEnabled, selectTurnRoute, runRoutedTurn };
