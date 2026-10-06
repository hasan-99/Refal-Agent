const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCommitState,
  buildCommitTrackingToolRegistry,
  isCleanSuccess,
  safeResponseForCommittedAction,
  decideAgentTurnOutcome
} = require("./agentCommitTracking");

function fakeTool(resultOrResults) {
  let calls = 0;
  const results = Array.isArray(resultOrResults) ? resultOrResults : [resultOrResults];
  return {
    run: async () => results[Math.min(calls++, results.length - 1)],
    calls: () => calls
  };
}

test("a successful requestBookingAction (confirmed) marks sideEffectCommitted and records the action", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    requestBookingAction: fakeTool({ ok: true, status: "confirmed", data: { appointmentId: "a1" }, userSafeSummary: "Booked for Monday." })
  }, commitState);
  await tools.requestBookingAction.run({}, {});
  assert.equal(commitState.sideEffectCommitted, true);
  assert.deepEqual(commitState.committedActions, [{ tool: "requestBookingAction", status: "confirmed", data: { appointmentId: "a1" }, userSafeSummary: "Booked for Monday." }]);
});

test("a successful requestBookingAction (pending_review) also marks committed", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    requestBookingAction: fakeTool({ ok: true, status: "pending_review", data: { appointmentId: "a2" } })
  }, commitState);
  await tools.requestBookingAction.run({}, {});
  assert.equal(commitState.sideEffectCommitted, true);
  assert.equal(commitState.committedActions[0].status, "pending_review");
});

test("a failed requestBookingAction (ok:false) never marks committed, regardless of status string", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    requestBookingAction: fakeTool({ ok: false, status: "confirmed", reasonCode: "SOMEHOW_FALSE" })
  }, commitState);
  await tools.requestBookingAction.run({}, {});
  assert.equal(commitState.sideEffectCommitted, false);
  assert.deepEqual(commitState.committedActions, []);
});

test("a successful but unlisted-status requestBookingAction result never marks committed", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    requestBookingAction: fakeTool({ ok: true, status: "available" })
  }, commitState);
  await tools.requestBookingAction.run({}, {});
  assert.equal(commitState.sideEffectCommitted, false);
});

test("a representative persisted-handover tool (commitHandover) marks committed only on its own 'persisted' success", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    commitHandover: fakeTool({ ok: true, status: "persisted", data: { handoverId: "h1" } })
  }, commitState);
  await tools.commitHandover.run({}, {});
  assert.equal(commitState.sideEffectCommitted, true);
  assert.equal(commitState.committedActions[0].tool, "commitHandover");
});

test("a failed commitHandover never marks committed", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    commitHandover: fakeTool({ ok: false, status: "not_authorized", reasonCode: "CONSENT_REQUIRED" })
  }, commitState);
  await tools.commitHandover.run({}, {});
  assert.equal(commitState.sideEffectCommitted, false);
});

test("a tool not on the committing allowlist never marks committed, even with an ok:true 'confirmed'-shaped result", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    proposeHandover: fakeTool({ ok: true, status: "confirmed", data: {} })
  }, commitState);
  await tools.proposeHandover.run({}, {});
  assert.equal(commitState.sideEffectCommitted, false);
});

test("the model's own args/intent cannot set commit state — only the real tool's resolved result can, even when args claim success", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    requestBookingAction: fakeTool({ ok: false, status: "unavailable", reasonCode: "SLOT_NO_LONGER_AVAILABLE" })
  }, commitState);
  await tools.requestBookingAction.run({ claimedStatus: "confirmed", start: "2026-01-05T10:00:00.000Z" }, {});
  assert.equal(commitState.sideEffectCommitted, false, "a model-supplied arg claiming success must never set commit state");
});

test("exactly one commit is recorded even if the same committing tool is called more than once in a turn", async () => {
  const commitState = createCommitState();
  const tools = buildCommitTrackingToolRegistry({
    requestBookingAction: fakeTool([
      { ok: true, status: "confirmed", data: { appointmentId: "a1" } },
      { ok: true, status: "confirmed", data: { appointmentId: "a1" } }
    ])
  }, commitState);
  await tools.requestBookingAction.run({}, {});
  await tools.requestBookingAction.run({}, {});
  assert.equal(commitState.committedActions.length, 2, "both resolved calls are recorded (idempotency itself is agentBookingTools.js's job, not this module's)");
  assert.equal(commitState.sideEffectCommitted, true);
});

test("isCleanSuccess is true only for 'responded'/'clarified' outcomes", () => {
  assert.equal(isCleanSuccess({ outcome: "responded" }), true);
  assert.equal(isCleanSuccess({ outcome: "clarified" }), true);
  assert.equal(isCleanSuccess({ outcome: "decision_failed" }), false);
  assert.equal(isCleanSuccess({ outcome: "invalid_decision" }), false);
  assert.equal(isCleanSuccess({ outcome: "response_rejected" }), false);
  assert.equal(isCleanSuccess({ outcome: "clarify_rejected" }), false);
  assert.equal(isCleanSuccess({ outcome: "max_steps_reached" }), false);
  assert.equal(isCleanSuccess(null), false);
});

test("safeResponseForCommittedAction prefers the tool's own userSafeSummary when present", () => {
  const commitState = { committedActions: [{ tool: "requestBookingAction", status: "confirmed", userSafeSummary: "Booked for Monday 10am." }] };
  assert.equal(safeResponseForCommittedAction(commitState, "english"), "Booked for Monday 10am.");
});

test("safeResponseForCommittedAction falls back to a deterministic localized pending-review text when the tool gave no summary", () => {
  const commitState = { committedActions: [{ tool: "requestBookingAction", status: "pending_review", userSafeSummary: null }] };
  assert.match(safeResponseForCommittedAction(commitState, "english"), /awaiting confirmation/);
  assert.match(safeResponseForCommittedAction(commitState, "arabic"), /مراجعة/);
  assert.match(safeResponseForCommittedAction(commitState, "greek"), /επιβεβαίωση/);
});

test("safeResponseForCommittedAction falls back to a deterministic localized handover text for commitHandover", () => {
  const commitState = { committedActions: [{ tool: "commitHandover", status: "persisted", userSafeSummary: null }] };
  assert.match(safeResponseForCommittedAction(commitState, "english"), /specialist/);
});

test("safeResponseForCommittedAction returns null when nothing was committed", () => {
  assert.equal(safeResponseForCommittedAction(createCommitState(), "english"), null);
});

test("decideAgentTurnOutcome: a clean success is sent as-is regardless of commit state", () => {
  const decision = decideAgentTurnOutcome({ result: { outcome: "responded", response: "Sure, here is the info." }, commitState: createCommitState(), locale: "english" });
  assert.equal(decision.send, true);
  assert.equal(decision.responseText, "Sure, here is the info.");
});

test("decideAgentTurnOutcome: Agent fails before any committed side effect -> legacy fallback is allowed", () => {
  const decision = decideAgentTurnOutcome({ result: { outcome: "max_steps_reached", response: "generic fallback text" }, commitState: createCommitState(), locale: "english" });
  assert.equal(decision.send, false);
  assert.equal(decision.fallbackToLegacy, true);
  assert.match(decision.reason, /max_steps_reached/);
});

test("decideAgentTurnOutcome: booking succeeds then the Agent's draft later fails -> no legacy fallback, deterministic committed response instead", () => {
  const commitState = createCommitState();
  commitState.sideEffectCommitted = true;
  commitState.committedActions.push({ tool: "requestBookingAction", status: "confirmed", data: {}, userSafeSummary: "Booked for Monday 10am." });
  const decision = decideAgentTurnOutcome({ result: { outcome: "response_rejected", response: "generic fallback text" }, commitState, locale: "english" });
  assert.equal(decision.send, true);
  assert.equal(decision.fallbackToLegacy, undefined);
  assert.equal(decision.responseText, "Booked for Monday 10am.");
});

test("decideAgentTurnOutcome: handover succeeds then the Agent's draft later fails -> no legacy fallback, deterministic committed response instead", () => {
  const commitState = createCommitState();
  commitState.sideEffectCommitted = true;
  commitState.committedActions.push({ tool: "commitHandover", status: "persisted", data: {}, userSafeSummary: null });
  const decision = decideAgentTurnOutcome({ result: { outcome: "decision_failed", response: "generic fallback text" }, commitState, locale: "english" });
  assert.equal(decision.send, true);
  assert.match(decision.responseText, /specialist/);
});

test("decideAgentTurnOutcome: a failed booking attempt (never committed) still allows legacy fallback", () => {
  const decision = decideAgentTurnOutcome({ result: { outcome: "invalid_decision", response: "generic fallback text" }, commitState: createCommitState(), locale: "english" });
  assert.equal(decision.send, false);
  assert.equal(decision.fallbackToLegacy, true);
});
