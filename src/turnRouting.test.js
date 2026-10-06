const test = require("node:test");
const assert = require("node:assert/strict");
const { isAgentLiveEnabled, selectTurnRoute, runRoutedTurn } = require("./turnRouting");
const { isShadowEnabled } = require("./agentShadow");

test("isAgentLiveEnabled defaults to false and only true for the literal 'true' string", () => {
  assert.equal(isAgentLiveEnabled({}), false);
  assert.equal(isAgentLiveEnabled({ REFAL_AGENT_LIVE_ENABLED: "false" }), false);
  assert.equal(isAgentLiveEnabled({ REFAL_AGENT_LIVE_ENABLED: "yes" }), false);
  assert.equal(isAgentLiveEnabled({ REFAL_AGENT_LIVE_ENABLED: "TRUE" }), true);
  assert.equal(isAgentLiveEnabled({ REFAL_AGENT_LIVE_ENABLED: "true" }), true);
});

test("selectTurnRoute is 'legacy' when the flag is unset/off", () => {
  assert.equal(selectTurnRoute({}), "legacy");
  assert.equal(selectTurnRoute({ REFAL_AGENT_LIVE_ENABLED: "false" }), "legacy");
});

test("selectTurnRoute is 'agent' only when the flag is explicitly 'true'", () => {
  assert.equal(selectTurnRoute({ REFAL_AGENT_LIVE_ENABLED: "true" }), "agent");
});

test("flag OFF: runRoutedTurn calls only runLegacyTurn, never runAgentTurn", async () => {
  let legacyCalled = false;
  let agentCalled = false;
  const result = await runRoutedTurn(
    { userId: "u1" },
    {
      env: {},
      runLegacyTurn: async () => { legacyCalled = true; return { sent: true }; },
      runAgentTurn: async () => { agentCalled = true; return { sent: true }; }
    }
  );
  assert.equal(legacyCalled, true);
  assert.equal(agentCalled, false);
  assert.equal(result.route, "legacy");
});

test("flag ON: runRoutedTurn calls only runAgentTurn when it succeeds, never runLegacyTurn", async () => {
  let legacyCalled = false;
  let agentCalled = false;
  const result = await runRoutedTurn(
    { userId: "u1" },
    {
      env: { REFAL_AGENT_LIVE_ENABLED: "true" },
      runLegacyTurn: async () => { legacyCalled = true; return { sent: true }; },
      runAgentTurn: async () => { agentCalled = true; return { outcome: "responded", sent: true }; }
    }
  );
  assert.equal(agentCalled, true);
  assert.equal(legacyCalled, false);
  assert.equal(result.route, "agent");
  assert.equal(result.outcome, "responded");
});

test("exactly one customer response is ever sent, across both routes", async () => {
  async function scenario(env, agentShouldThrow) {
    const sent = [];
    await runRoutedTurn(
      { userId: "u1" },
      {
        env,
        runLegacyTurn: async () => { sent.push("legacy"); return {}; },
        runAgentTurn: async () => {
          if (agentShouldThrow) throw new Error("setup blew up before any tool ran");
          sent.push("agent");
          return {};
        }
      }
    );
    return sent;
  }

  assert.deepEqual(await scenario({}, false), ["legacy"]);
  assert.deepEqual(await scenario({ REFAL_AGENT_LIVE_ENABLED: "true" }, false), ["agent"]);
  assert.deepEqual(await scenario({ REFAL_AGENT_LIVE_ENABLED: "true" }, true), ["legacy"], "a pre-side-effect Agent failure must fall back to legacy, and legacy must be the only one to send");
});

test("Agent pre-side-effect failure (a throw out of runAgentTurn) falls back to legacy and reports the fallback route", async () => {
  const result = await runRoutedTurn(
    { userId: "u1" },
    {
      env: { REFAL_AGENT_LIVE_ENABLED: "true" },
      runLegacyTurn: async () => ({ outcome: "legacy_sent" }),
      runAgentTurn: async () => { throw new Error("context build failed"); }
    }
  );
  assert.equal(result.route, "agent_fallback_legacy");
  assert.equal(result.outcome, "legacy_sent");
  assert.match(result.fallbackReason, /context build failed/);
});

test("disabling the flag after having it on immediately restores legacy-only routing (rollback is trivial)", async () => {
  const calls = [];
  const deps = (env) => ({
    env,
    runLegacyTurn: async () => { calls.push(`legacy:${env.REFAL_AGENT_LIVE_ENABLED || "unset"}`); return {}; },
    runAgentTurn: async () => { calls.push(`agent:${env.REFAL_AGENT_LIVE_ENABLED}`); return {}; }
  });

  await runRoutedTurn({}, deps({ REFAL_AGENT_LIVE_ENABLED: "true" }));
  await runRoutedTurn({}, deps({ REFAL_AGENT_LIVE_ENABLED: "false" }));

  assert.deepEqual(calls, ["agent:true", "legacy:false"]);
});

test("the real inbound provider message id passed into runRoutedTurn reaches runAgentTurn unchanged", async () => {
  let receivedProviderMessageId = null;
  await runRoutedTurn(
    { userId: "u1", providerMessageId: "wa-msg-real-123" },
    {
      env: { REFAL_AGENT_LIVE_ENABLED: "true" },
      runLegacyTurn: async () => ({}),
      runAgentTurn: async (params) => { receivedProviderMessageId = params.providerMessageId; return {}; }
    }
  );
  assert.equal(receivedProviderMessageId, "wa-msg-real-123");
});

test("shadow mode's own flag is independent of the live-routing flag in both directions", () => {
  // Enabling live routing does not implicitly enable shadow mode.
  assert.equal(isShadowEnabled({ REFAL_AGENT_LIVE_ENABLED: "true" }), false);
  // Enabling shadow mode does not implicitly select the Agent route.
  assert.equal(selectTurnRoute({ REFAL_AGENT_SHADOW_ENABLED: "true" }), "legacy");
  // Both can be independently on at once; neither function reads the other's env key.
  assert.equal(isShadowEnabled({ REFAL_AGENT_SHADOW_ENABLED: "true", REFAL_AGENT_LIVE_ENABLED: "true" }), true);
  assert.equal(selectTurnRoute({ REFAL_AGENT_SHADOW_ENABLED: "true", REFAL_AGENT_LIVE_ENABLED: "true" }), "agent");
});

test("runRoutedTurn requires a runLegacyTurn callback regardless of route (fails loud, never silently no-ops)", async () => {
  await assert.rejects(runRoutedTurn({}, { env: {} }), /runLegacyTurn/);
});

test("runRoutedTurn requires a runAgentTurn callback only when the agent route is actually selected", async () => {
  await assert.doesNotReject(runRoutedTurn({}, { env: {}, runLegacyTurn: async () => ({}) }));
  await assert.rejects(
    runRoutedTurn({}, { env: { REFAL_AGENT_LIVE_ENABLED: "true" }, runLegacyTurn: async () => ({}) }),
    /runAgentTurn/
  );
});
