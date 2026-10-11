const test = require("node:test");
const assert = require("node:assert/strict");
const {
  runShadowAgentTurn,
  recordShadowComparison,
  isShadowEnabled,
  buildShadowToolRegistry,
  maxConcurrency,
  __resetShadowConcurrency
} = require("./agentShadow");
const { TOOL_REGISTRY } = require("./agentTools");

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test.beforeEach(() => __resetShadowConcurrency());

test("isShadowEnabled defaults to false and only true for the literal 'true' string", () => {
  assert.equal(isShadowEnabled({}), false);
  assert.equal(isShadowEnabled({ REFAL_AGENT_SHADOW_ENABLED: "false" }), false);
  assert.equal(isShadowEnabled({ REFAL_AGENT_SHADOW_ENABLED: "yes" }), false);
  assert.equal(isShadowEnabled({ REFAL_AGENT_SHADOW_ENABLED: "TRUE" }), true);
  assert.equal(isShadowEnabled({ REFAL_AGENT_SHADOW_ENABLED: "true" }), true);
});

test("maxConcurrency defaults to 3 and only accepts a positive finite override", () => {
  assert.equal(maxConcurrency({}), 3);
  assert.equal(maxConcurrency({ REFAL_AGENT_SHADOW_MAX_CONCURRENCY: "5" }), 5);
  assert.equal(maxConcurrency({ REFAL_AGENT_SHADOW_MAX_CONCURRENCY: "0" }), 3);
  assert.equal(maxConcurrency({ REFAL_AGENT_SHADOW_MAX_CONCURRENCY: "-1" }), 3);
  assert.equal(maxConcurrency({ REFAL_AGENT_SHADOW_MAX_CONCURRENCY: "not-a-number" }), 3);
});

test("buildShadowToolRegistry is default-deny: only the explicit read-only allowlist keeps its real run function", () => {
  const shadowTools = buildShadowToolRegistry(TOOL_REGISTRY);
  assert.equal(shadowTools.searchApprovedKnowledge.run, TOOL_REGISTRY.searchApprovedKnowledge.run);
  assert.equal(shadowTools.getCustomerContext.run, TOOL_REGISTRY.getCustomerContext.run);
  assert.equal(shadowTools.getBookingAvailability.run, TOOL_REGISTRY.getBookingAvailability.run);
  assert.equal(shadowTools.proposeHandover.run, TOOL_REGISTRY.proposeHandover.run);
  assert.notEqual(shadowTools.saveCustomerFact.run, TOOL_REGISTRY.saveCustomerFact.run);
  assert.notEqual(shadowTools.requestBookingAction.run, TOOL_REGISTRY.requestBookingAction.run);
});

test("buildShadowToolRegistry dry-runs an unrecognized/future tool name by default (fail-safe, not fail-open)", async () => {
  const futureTools = {
    ...TOOL_REGISTRY,
    deleteCustomerAccount: { description: "a hypothetical future write tool nobody added to the allowlist", run: async () => ({ ok: true, status: "deleted" }) }
  };
  const shadowTools = buildShadowToolRegistry(futureTools);
  const result = await shadowTools.deleteCustomerAccount.run({});
  assert.equal(result.status, "shadow_skipped");
});

test("runShadowAgentTurn is a complete no-op when the flag is unset — no model/tool/store calls, no logEvent", async () => {
  let storeCalled = false;
  let logCalled = false;
  let decideCalled = false;
  const result = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "hello",
      user: { id: "u1", history: [] },
      store: { searchKnowledge: async () => { storeCalled = true; return []; } },
      classification: { language: "english", intents: [] },
      logEvent: () => { logCalled = true; }
    },
    { env: {}, decideNextStep: async () => { decideCalled = true; return { type: "respond", text: "x" }; } }
  );
  assert.equal(result, null);
  assert.equal(storeCalled, false);
  assert.equal(logCalled, false);
  assert.equal(decideCalled, false);
});

test("runShadowAgentTurn, when enabled, reaches the real tool/store through a scripted decision and logs outcome metadata only (no response text)", async () => {
  let searchArgs = null;
  const store = {
    searchKnowledge: async (query) => { searchArgs = query; return [{ heading: "Pricing", content: "EUR 1500" }]; }
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "price" } },
    { type: "respond", text: "The price is EUR 1500." }
  ]);
  const events = [];

  const result = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "what is the price?",
      user: { id: "u1", history: [{ message: "hi", response: "Hello, how can I help?" }] },
      store,
      classification: { language: "english", intents: ["pricing"] },
      logEvent: (event, fields) => events.push({ event, fields }),
      embedText: async () => [1, 2, 3]
    },
    { env: { REFAL_AGENT_SHADOW_ENABLED: "true" }, decideNextStep: decide, tools: TOOL_REGISTRY }
  );

  assert.equal(searchArgs, "price");
  assert.equal(result.outcome, "responded");
  assert.equal(result.toolsUsed[0], "searchApprovedKnowledge");
  assert.match(result.response, /EUR 1500/);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "agent_turn_completed");
  assert.equal(events[0].fields.finalOutcome, "responded");
  assert.equal(events[0].fields.shadowMode, true);
  assert.deepEqual(events[0].fields.toolsUsed, ["searchApprovedKnowledge"]);
  assert.equal(events[0].fields.ragUsed, true);
  assert.equal(events[0].fields.ragResultStatus, "found");
  assert.equal(events[0].fields.responseLength, "The price is EUR 1500.".length);
  assert.equal(events[0].fields.response, undefined, "the logged event must never carry the free-text response");
  assert.deepEqual(events[0].fields.toolCalls, [
    { tool: "searchApprovedKnowledge", status: "found", ok: true, reasonCode: null },
    { tool: "searchApprovedKnowledge", status: "found", ok: true, reasonCode: null }
  ]);
  assert.equal(events[0].fields.toolCalls[0].args, undefined, "a tool-call observation must never carry raw args");
});

test("runShadowAgentTurn never persists through saveCustomerFact or requestBookingAction even when the decision step calls them", async () => {
  let storeWriteCalled = false;
  const store = {
    updateUser: async () => { storeWriteCalled = true; },
    createAppointment: async () => { storeWriteCalled = true; return { id: "appt-1" }; }
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "saveCustomerFact", args: { field: "companyActivity", value: "trading", provenance: "customer_message" } },
    { type: "tool", tool: "requestBookingAction", args: { start: "2026-01-05T10:00:00.000Z", end: "2026-01-05T10:30:00.000Z" } },
    { type: "respond", text: "Noted, thank you." }
  ]);
  const events = [];

  const result = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "our company does trading, book me Monday 10am",
      user: { id: "u1", history: [] },
      store,
      classification: { language: "english", intents: [] },
      logEvent: (event, fields) => events.push({ event, fields })
    },
    { env: { REFAL_AGENT_SHADOW_ENABLED: "true" }, decideNextStep: decide, tools: TOOL_REGISTRY }
  );

  assert.equal(storeWriteCalled, false);
  assert.equal(result.steps[0].result.status, "shadow_skipped");
  assert.equal(result.steps[1].result.status, "shadow_skipped");
  assert.equal(result.outcome, "responded");
});

test("runShadowAgentTurn caps concurrency: a burst beyond the limit is skipped and logged, not queued", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const decide = async () => { await gate; return { type: "respond", text: "done" }; };
  const events = [];
  const makeArgs = (n) => ({
    userId: `u${n}`,
    text: "hello",
    user: { id: `u${n}`, history: [] },
    store: {},
    classification: { language: "english", intents: [] },
    logEvent: (event, fields) => events.push({ event, fields, n })
  });
  const opts = { env: { REFAL_AGENT_SHADOW_ENABLED: "true", REFAL_AGENT_SHADOW_MAX_CONCURRENCY: "2" }, decideNextStep: decide, tools: TOOL_REGISTRY };

  const inFlight = [
    runShadowAgentTurn(makeArgs(1), opts),
    runShadowAgentTurn(makeArgs(2), opts)
  ];
  // Give the first two a tick to register as in-flight before the third fires.
  await Promise.resolve();
  const third = await runShadowAgentTurn(makeArgs(3), opts);

  assert.equal(third, null, "the 3rd concurrent call beyond the cap of 2 must be skipped, not queued");
  assert.equal(events.some((e) => e.event === "agent_shadow_turn_skipped" && e.n === 3), true);

  release();
  const [first, second] = await Promise.all(inFlight);
  assert.equal(first.outcome, "responded");
  assert.equal(second.outcome, "responded");
});

test("runShadowAgentTurn catches a thrown decision/tool error and logs agent_turn_completed instead of throwing", async () => {
  const events = [];
  const result = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "hello",
      user: { id: "u1", history: [] },
      store: {},
      classification: { language: "english", intents: [] },
      logEvent: (event, fields) => events.push({ event, fields })
    },
    {
      env: { REFAL_AGENT_SHADOW_ENABLED: "true" },
      decideNextStep: async () => { throw new Error("boom"); },
      tools: TOOL_REGISTRY
    }
  );

  // runAgentTurn already converts a thrown decideNextStep into a safe
  // "decision_failed" outcome rather than a rejection (see agentLoop.js), so
  // this confirms the shadow wrapper passes that outcome through and still
  // logs the normal success event rather than treating it as a shadow-layer
  // failure.
  assert.equal(result.outcome, "decision_failed");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "agent_turn_completed");
  assert.equal(events[0].fields.finalOutcome, "decision_failed");
  assert.equal(events[0].fields.fallbackUsed, true);
});

test("runShadowAgentTurn catches an unexpected throw from its own setup (e.g. a broken user object) and logs agent_shadow_turn_error without throwing", async () => {
  const events = [];
  const brokenUser = {
    get history() { throw new Error("profile store corrupted"); }
  };

  const result = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "hello",
      user: brokenUser,
      store: {},
      classification: { language: "english", intents: [] },
      logEvent: (event, fields) => events.push({ event, fields })
    },
    { env: { REFAL_AGENT_SHADOW_ENABLED: "true" }, decideNextStep: scriptedDecider([{ type: "respond", text: "hi" }]) }
  );

  assert.equal(result, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "agent_turn_failed");
  assert.equal(events[0].fields.shadowMode, true);
  assert.match(events[0].fields.message, /profile store corrupted/);
});

test("REFAL-AGENT-013: a throwing logEvent on the success path does not discard an otherwise-successful turn result (test 10)", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "You're welcome, happy to help anytime." }]);
  const result = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "thank you",
      user: { id: "u1", history: [] },
      store: {},
      classification: { language: "english", intents: [] },
      logEvent: () => { throw new Error("telemetry sink is down"); }
    },
    { env: { REFAL_AGENT_SHADOW_ENABLED: "true" }, decideNextStep: decide }
  );
  assert.equal(result.outcome, "responded");
  assert.match(result.response, /happy to help/);
});

test("REFAL-AGENT-013: a rejecting (async) logEvent never surfaces as an unhandled rejection or a thrown error (test 17)", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "You're welcome, happy to help anytime." }]);
  const result = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "thank you",
      user: { id: "u1", history: [] },
      store: {},
      classification: { language: "english", intents: [] },
      logEvent: () => Promise.reject(new Error("telemetry sink is down"))
    },
    { env: { REFAL_AGENT_SHADOW_ENABLED: "true" }, decideNextStep: decide }
  );
  assert.equal(result.outcome, "responded");

  // Also exercise the error (agent_turn_failed) path with a throwing logger —
  // runShadowAgentTurn itself must still resolve to null, not reject.
  const broken = { get history() { throw new Error("boom"); } };
  const erroredResult = await runShadowAgentTurn(
    {
      userId: "u1",
      text: "hello",
      user: broken,
      store: {},
      classification: { language: "english", intents: [] },
      logEvent: () => { throw new Error("telemetry sink is down"); }
    },
    { env: { REFAL_AGENT_SHADOW_ENABLED: "true" }, decideNextStep: scriptedDecider([{ type: "respond", text: "hi" }]) }
  );
  assert.equal(erroredResult, null);
});

test("REFAL-AGENT-013: a secret embedded in the customer's message never appears in any logged event payload (test 14)", async () => {
  const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
  const customerMessage = `My API key is ${secret}, please save it as a note.`;
  const decide = scriptedDecider([
    { type: "tool", tool: "saveCustomerFact", args: { field: "apiKey", value: secret, provenance: "customer_message" } },
    { type: "respond", text: "I can't store that kind of information, but I can help with anything else." }
  ]);
  const events = [];
  await runShadowAgentTurn(
    {
      userId: "u1",
      text: customerMessage,
      user: { id: "u1", history: [] },
      store: { updateUser: async () => {} },
      classification: { language: "english", intents: [] },
      logEvent: (event, fields) => events.push({ event, fields })
    },
    { env: { REFAL_AGENT_SHADOW_ENABLED: "true" }, decideNextStep: decide, tools: TOOL_REGISTRY }
  );
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, new RegExp(secret.replace(/[-]/g, "\\-")));
  assert.doesNotMatch(serialized, /API key/i);
});

test("REFAL-AGENT-013: the Ticket 010 concurrency-skip event name/fields are unchanged (test 16)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const decide = async () => { await gate; return { type: "respond", text: "done" }; };
  const events = [];
  const opts = { env: { REFAL_AGENT_SHADOW_ENABLED: "true", REFAL_AGENT_SHADOW_MAX_CONCURRENCY: "1" }, decideNextStep: decide, tools: TOOL_REGISTRY };
  const first = runShadowAgentTurn({ userId: "u1", text: "hello", user: { id: "u1", history: [] }, store: {}, classification: { language: "english", intents: [] }, logEvent: (event, fields) => events.push({ event, fields }) }, opts);
  await Promise.resolve();
  const second = await runShadowAgentTurn({ userId: "u2", text: "hello", user: { id: "u2", history: [] }, store: {}, classification: { language: "english", intents: [] }, logEvent: (event, fields) => events.push({ event, fields }) }, opts);
  assert.equal(second, null);
  const skipEvent = events.find((e) => e.event === "agent_shadow_turn_skipped");
  assert.ok(skipEvent, "the skip event name must stay exactly agent_shadow_turn_skipped");
  assert.deepEqual(Object.keys(skipEvent.fields).sort(), ["activeShadowTurns", "limit", "reasonCode", "traceId"]);
  assert.equal(skipEvent.fields.reasonCode, "CONCURRENCY_LIMIT");
  release();
  await first;
});

test("recordShadowComparison joins a resolved shadow result with a legacy summary and emits only safe categorical fields (tests 11-13)", async () => {
  const events = [];
  const agentResult = { outcome: "responded", response: "The agent's own drafted reply text.", steps: [], toolsUsed: ["getBookingAvailability"], stepCount: 2, durationMs: 80 };
  await recordShadowComparison({
    shadowTurnPromise: Promise.resolve(agentResult),
    legacySummary: { primaryIntentCategory: "appointment", usedBookingPath: true, usedHandoverPath: false, responseLength: 58 },
    traceId: "trace-xyz",
    logEvent: (event, fields) => events.push({ event, fields })
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "agent_shadow_comparison");
  assert.equal(events[0].fields.traceId, "trace-xyz");
  assert.equal(events[0].fields.legacyUsedBookingPath, true);
  assert.equal(events[0].fields.legacyResponseLength, 58);
  assert.equal(events[0].fields.agentResponseLength, agentResult.response.length);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /The agent's own drafted reply text/);
});

test("recordShadowComparison is a silent no-op when there is no legacy summary, no resolved shadow result, or logEvent is missing", async () => {
  const events = [];
  const logEvent = (event, fields) => events.push({ event, fields });
  await recordShadowComparison({ shadowTurnPromise: Promise.resolve(null), legacySummary: { responseLength: 1 }, traceId: "t", logEvent });
  await recordShadowComparison({ shadowTurnPromise: Promise.resolve({ outcome: "responded", response: "x", toolsUsed: [] }), legacySummary: null, traceId: "t", logEvent });
  await recordShadowComparison({ shadowTurnPromise: Promise.resolve({ outcome: "responded", response: "x", toolsUsed: [] }), legacySummary: { responseLength: 1 }, traceId: "t" });
  assert.equal(events.length, 0);
});

test("recordShadowComparison never throws even when the shadow promise rejects or logEvent rejects", async () => {
  await assert.doesNotReject(recordShadowComparison({
    shadowTurnPromise: Promise.reject(new Error("turn blew up")),
    legacySummary: { responseLength: 1 },
    traceId: "t",
    logEvent: () => {}
  }));
  await assert.doesNotReject(recordShadowComparison({
    shadowTurnPromise: Promise.resolve({ outcome: "responded", response: "x", toolsUsed: [] }),
    legacySummary: { responseLength: 1 },
    traceId: "t",
    logEvent: () => Promise.reject(new Error("sink down"))
  }));
});
