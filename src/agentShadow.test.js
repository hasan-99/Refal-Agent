const test = require("node:test");
const assert = require("node:assert/strict");
const {
  runShadowAgentTurn,
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
  assert.equal(events[0].event, "agent_shadow_turn");
  assert.equal(events[0].fields.outcome, "responded");
  assert.deepEqual(events[0].fields.toolsUsed, ["searchApprovedKnowledge"]);
  assert.equal(events[0].fields.responseLength, "The price is EUR 1500.".length);
  assert.equal(events[0].fields.response, undefined, "the logged event must never carry the free-text response");
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

test("runShadowAgentTurn catches a thrown decision/tool error and logs agent_shadow_turn instead of throwing", async () => {
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
  assert.equal(events[0].event, "agent_shadow_turn");
  assert.equal(events[0].fields.outcome, "decision_failed");
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
  assert.equal(events[0].event, "agent_shadow_turn_error");
  assert.match(events[0].fields.message, /profile store corrupted/);
});
