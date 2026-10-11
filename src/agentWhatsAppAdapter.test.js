"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveDynamicActionCapabilities,
  safeAgentSourceMessage,
  runAgentAfterPreflight
} = require("./agentWhatsAppAdapter");
const { runRoutedTurn } = require("./turnRouting");
const { runAgentTurnForContact } = require("./agentRuntime");
const { prepareInboundMessage, routeMessageResult } = require("./messageRouter");

function eligibleInput(overrides = {}) {
  return {
    prepared: {
      safety: { restricted: false, risks: [] },
      classification: { intents: ["pricing"] },
      complianceTriggers: [],
      metadata: { safety: { restricted: false, risks: [] }, intent: { intents: ["pricing"] } }
    },
    routed: { shouldUseAi: true, response: "", metadata: { intent: { intents: ["pricing"] } } },
    ...overrides
  };
}

test("credential-bearing AI question uses only its privacy-safe rewrite for model input and source-turn persistence", async () => {
  const secret = "SecretPhrase-81";
  const rawMessage = `My name is Rami. Password: ${secret}. Help me set up a company in Cyprus`;
  const user = { id: "synthetic-privacy-contact", profile: {}, history: [] };
  const store = {
    ensureUser: async () => user,
    getUser: async () => user,
    updateUser: async (_id, updater) => updater(user),
    addHistory: async (_id, message, response, extra) => {
      const turn = { id: `turn-${user.history.length + 1}`, message, response, metadata: extra?.metadata || {} };
      user.history.push(turn);
      return turn;
    },
    searchKnowledge: async () => [{ chunk_id: "synthetic-approved-company-setup", source_name: "Synthetic approved fixture",
      heading: "Company setup", content: "The approved test fixture says company setup includes registration and initial setup support.",
      review_status: "approved", valid_until: "2099-01-01T00:00:00.000Z" }],
    saveQualification: async () => {},
    saveIntents: async () => {}
  };
  const prepared = await prepareInboundMessage({ userId: user.id, incoming: rawMessage, user, store });
  const routed = await routeMessageResult({ userId: user.id, text: rawMessage, store, existingUser: user, preparedInbound: prepared });
  assert.equal(routed.shouldUseAi, true);
  assert.ok(routed.metadata.privacySafeQuestion);
  const safeMessage = safeAgentSourceMessage(rawMessage, prepared, routed);
  assert.doesNotMatch(safeMessage, new RegExp(secret));
  assert.match(safeMessage, /Help me set up a company in Cyprus/);

  let providerInput = "";
  const persisted = await runAgentAfterPreflight({
    prepared, routed, userId: user.id, sourceMessage: safeMessage
  }, {
    persistTurn: async ({ message, response, metadata }) => store.addHistory(user.id, message, response, { metadata }),
    runAgent: async () => {
      const agentResult = await runAgentTurnForContact({
        currentMessage: safeAgentSourceMessage(rawMessage, prepared, routed),
        locale: "english",
        contact: { id: user.id },
        recentConversation: [],
        store,
        user,
        userId: user.id,
        intents: routed.metadata?.intent?.intents || [],
        language: "english",
        embedText: async () => [0.1]
      }, {
        decideNextStep: async ({ context, observations }) => {
          providerInput = context.currentMessage;
          assert.ok(observations[0].result.modelObservation.evidence.length > 0);
          return { type: "respond", text: "The approved test fixture says company setup includes registration and initial setup support. What business activity are you considering?" };
        }
      });
      return agentResult.response;
    },
    updateTurn: async ({ turnId, patch }) => {
      const turn = user.history.find((row) => row.id === turnId);
      Object.assign(turn, patch);
      return turn;
    },
    send: async () => {}
  });

  assert.equal(persisted.sent, true);
  assert.doesNotMatch(providerInput, new RegExp(secret), "the Agent provider input is sanitized");
  assert.doesNotMatch(JSON.stringify(user.history), new RegExp(secret), "saved history contains no credential");
});

test("capability derivation grants only upsertLead on a clean AI-eligible turn", () => {
  const result = deriveDynamicActionCapabilities(eligibleInput());
  assert.deepEqual(result, ["upsertLead"]);
  assert.equal(Object.isFrozen(result), true);
});

test("capability derivation denies deterministic routes and missing safety or intent evidence", () => {
  assert.deepEqual(deriveDynamicActionCapabilities(eligibleInput({ routed: { shouldUseAi: false } })), []);
  assert.deepEqual(deriveDynamicActionCapabilities(eligibleInput({ prepared: { classification: { intents: ["pricing"] } } })), []);
  const noIntent = eligibleInput();
  noIntent.prepared.classification = {};
  noIntent.routed.metadata.intent = {};
  assert.deepEqual(deriveDynamicActionCapabilities(noIntent), []);
  const noSafety = eligibleInput();
  delete noSafety.prepared.safety;
  assert.deepEqual(deriveDynamicActionCapabilities(noSafety), []);
});

test("capability derivation denies privacy-safe, safety-risk, restricted, and compliance turns", () => {
  const cases = [
    { prepared: { safety: { restricted: true, risks: [] } } },
    { prepared: { safety: { restricted: false, risks: ["privacy"] } } },
    { prepared: { metadata: { privacySafeQuestion: "safe excerpt" } } },
    { routed: { metadata: { privacySafeQuestion: "safe excerpt" } } },
    { prepared: { complianceTriggers: ["sanctions_concern"] } },
    { routed: { metadata: { complianceEscalation: { record: { triggers: ["aml_concern"] } } } } }
  ];
  for (const overrides of cases) {
    const base = eligibleInput();
    if (overrides.prepared) base.prepared = { ...base.prepared, ...overrides.prepared };
    if (overrides.routed) base.routed = { ...base.routed, ...overrides.routed };
    assert.deepEqual(deriveDynamicActionCapabilities(base), [], JSON.stringify(overrides));
  }
});

test("every protected deterministic intent suppresses dynamic action capability", () => {
  for (const intent of ["complaint", "existing_client", "legal", "tax", "immigration", "banking", "permit", "approval", "appointment", "privacy", "prompt_injection"]) {
    const input = eligibleInput({
      prepared: { ...eligibleInput().prepared, classification: { intents: ["pricing", intent] } }
    });
    assert.deepEqual(deriveDynamicActionCapabilities(input), [], intent);
  }
});

test("deterministic outcome reuses its response and turn without persisting or invoking Agent", async () => {
  const events = [];
  const turn = { id: "existing-turn" };
  const result = await runAgentAfterPreflight({ routed: { shouldUseAi: false, response: "Existing safe response", turn } }, {
    persistTurn: async () => { events.push("persist"); },
    runAgent: async () => { events.push("agent"); },
    updateTurn: async () => { events.push("update"); },
    send: async (response, sentTurn) => { events.push(["send", response, sentTurn]); }
  });
  assert.deepEqual(events, [["send", "Existing safe response", turn]]);
  assert.equal(result.route, "deterministic");
  assert.equal(result.sent, true);
});

test("AI outcome persists before Agent, passes turn id and narrow grants, then updates and sends once", async () => {
  const events = [];
  const turn = { id: "source-turn-44" };
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "I need the current package price.", locale: "english"
  }, {
    persistTurn: async (input) => { events.push(["persist", input]); return turn; },
    runAgent: async (input) => { events.push(["agent", input]); return { responseText: "The current offer is available." }; },
    updateTurn: async (input) => { events.push(["update", input]); return { ...turn, response: input.patch.response }; },
    send: async (response, sentTurn) => { events.push(["send", response, sentTurn]); }
  });

  assert.deepEqual(events.map((event) => event[0]), ["persist", "agent", "update", "send"]);
  assert.equal(events[0][1].userId, "contact-1");
  assert.equal(events[0][1].message, "I need the current package price.");
  assert.equal(events[1][1].sourceTurnId, turn.id);
  assert.deepEqual(events[1][1].allowedCapabilities, ["upsertLead"]);
  assert.equal(events[2][1].turnId, turn.id);
  assert.equal(events[2][1].patch.response, "The current offer is available.");
  assert.deepEqual(Object.keys(events[2][1].patch), ["response"], "the history update must respect the Edge metadata patch allowlist");
  assert.equal(events[3][1], "The current offer is available.");
  assert.equal(events[3][2].id, turn.id);
  assert.equal(result.sent, true);
  assert.equal(result.persistenceUpdated, true);
});

test("full synthetic customer-answer path retrieves approved fixture evidence, runs Agent gates, persists and sends one answer", async () => {
  const events = [];
  const turn = { id: "turn-e2e-1" };
  const sourceMessage = "What is the price to create a Cyprus company?";
  const expectedAnswer = "In this synthetic fixture, the example formation price is EUR 1500.";
  const store = {
    searchKnowledge: async (query, embedding, embeddingModel, matchCount) => {
      events.push(["retrieve", query]);
      assert.equal(embedding[0], query.length);
      assert.equal(matchCount, 20);
      return [{ chunk_id: "approved-formation-price", source_name: "Synthetic approved test fixture", heading: "Example price",
        content: expectedAnswer, review_status: "approved", valid_until: "2099-01-01T00:00:00.000Z" }];
    }
  };
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-e2e", sourceMessage, locale: "english"
  }, {
    persistTurn: async ({ userId, message, response }) => {
      events.push(["persist", userId, message, response]);
      return turn;
    },
    runAgent: async ({ sourceTurnId, allowedCapabilities }) => {
      events.push(["agent-start", sourceTurnId, allowedCapabilities]);
      const agent = await runAgentTurnForContact({
        currentMessage: sourceMessage,
        locale: "english",
        contact: { id: "contact-e2e", name: null },
        recentConversation: [],
        store,
        user: { id: "contact-e2e", history: [] },
        userId: "contact-e2e",
        intents: ["pricing"],
        language: "english",
        sourceTurnId,
        embedText: async (query) => [query.length]
      }, {
        decideNextStep: async ({ observations, step }) => {
          if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: sourceMessage } };
          assert.equal(observations[0].result.modelObservation.evidence[0].content, expectedAnswer);
          assert.equal(observations[0].result.modelObservation.policyEvidence[0].review_status, "approved");
          assert.equal(observations[0].result.modelObservation.policyEvidence[0].valid_until, "2099-01-01T00:00:00.000Z");
          return { type: "respond", text: expectedAnswer };
        }
      });
      events.push(["agent-done", agent.outcome, agent.toolsUsed]);
      return agent.response;
    },
    updateTurn: async ({ userId, turnId, patch }) => {
      events.push(["update", userId, turnId, patch.response]);
      return { ...turn, response: patch.response };
    },
    send: async (response, sentTurn) => events.push(["send", response, sentTurn.id])
  });

  assert.equal(result.sent, true);
  assert.equal(result.persistenceUpdated, true);
  assert.deepEqual(events.map(([name]) => name), ["persist", "agent-start", "retrieve", "agent-done", "update", "send"]);
  assert.equal(events.at(-1)[1], expectedAnswer);
  assert.equal(events.at(-1)[2], turn.id);
});

test("continuity summary hook runs only after the source turn and response are durable", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "I am looking at property in Limassol."
  }, {
    persistTurn: async () => ({ id: "turn-1" }),
    runAgent: async () => "What kind of property are you considering?",
    updateTurn: async ({ patch }) => ({ id: "turn-1", response: patch.response }),
    afterTurnPersisted: async ({ userId, turnId, message }) => { events.push(["summary", userId, turnId, message]); },
    send: async () => { events.push(["send"]); }
  });
  assert.deepEqual(events, [
    ["summary", "contact-1", "turn-1", "I am looking at property in Limassol."],
    ["send"]
  ]);
  assert.equal(result.sent, true);
});

test("continuity summary failure never changes the saved response or retries a persisted turn", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "Tell me about property."
  }, {
    persistTurn: async () => ({ id: "turn-1" }),
    runAgent: async () => "I can help with your question.",
    updateTurn: async ({ patch }) => ({ id: "turn-1", response: patch.response }),
    afterTurnPersisted: async () => { events.push("summary"); throw new Error("profile write failed"); },
    send: async (response) => { events.push(["send", response]); }
  });
  assert.deepEqual(events, ["summary", ["send", "I can help with your question."]]);
  assert.equal(result.sent, true);
  assert.equal(result.persistenceUpdated, true);
});

test("source turn persistence failure prevents Agent and update, then sends a safe response once", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "Can you explain the package?"
  }, {
    persistTurn: async () => { events.push("persist"); throw new Error("database unavailable"); },
    runAgent: async () => { events.push("agent"); },
    updateTurn: async () => { events.push("update"); },
    send: async () => { events.push("send"); }
  });
  assert.deepEqual(events, ["persist", "send"]);
  assert.equal(result.persistenceUncertain, true);
});

test("ambiguous source-turn insert failure sends once without legacy retry or Agent side effects", async () => {
  const calls = [];
  const result = await runRoutedTurn({}, {
    env: { REFAL_AGENT_LIVE_ENABLED: "true" },
    runLegacyTurn: async () => { calls.push("legacy"); return { sent: true }; },
    runAgentTurn: () => runAgentAfterPreflight({
      ...eligibleInput(),
      userId: "u-ambiguous",
      sourceMessage: "Tell me about your service",
      locale: "en"
    }, {
      persistTurn: async () => { calls.push("insert"); throw new Error("response lost after commit"); },
      runAgent: async () => { calls.push("agent"); return "answer"; },
      updateTurn: async () => { calls.push("update"); },
      send: async (response, turn) => { calls.push(["send", response, turn]); },
      safeFallback: async () => "Please try again later."
    })
  });

  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["insert", "send"]);
  assert.equal(result.route, "agent");
  assert.equal(calls[1][2], null);
  assert.equal(result.persistenceUncertain, true);
  assert.equal(result.sent, true);
});

test("missing persisted turn id prevents Agent and sends a safe response once", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "Question"
  }, {
    persistTurn: async () => ({}),
    runAgent: async () => { events.push("agent"); },
    updateTurn: async () => {},
    send: async () => { events.push("send"); }
  });
  assert.deepEqual(events, ["send"]);
  assert.equal(result.persistenceUncertain, true);
});

test("Agent error uses injected safe fallback and never throws or runs a second path", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "Question", locale: "greek"
  }, {
    persistTurn: async () => ({ id: "turn-1" }),
    runAgent: async () => { events.push("agent"); throw new Error("provider failed"); },
    updateTurn: async ({ patch }) => { events.push(["update", patch.response]); },
    send: async (response) => { events.push(["send", response]); },
    safeFallback: async ({ stage }) => { events.push(["fallback", stage]); return "Safe reply."; }
  });
  assert.deepEqual(events, ["agent", ["fallback", "agent"], ["update", "Safe reply."], ["send", "Safe reply."]]);
  assert.equal(result.sent, true);
  assert.ok(result.agentError instanceof Error);
});

test("update failure falls back safely, sends once, and does not retry update or Agent", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "Question"
  }, {
    persistTurn: async () => ({ id: "turn-1" }),
    runAgent: async () => { events.push("agent"); return "Draft answer"; },
    updateTurn: async () => { events.push("update"); throw new Error("patch failed"); },
    send: async (response) => { events.push(["send", response]); },
    safeFallback: async ({ stage }) => { events.push(["fallback", stage]); return "Please try again later."; }
  });
  assert.deepEqual(events, ["agent", "update", ["fallback", "update"], ["send", "Please try again later."]]);
  assert.equal(result.persistenceUpdated, false);
  assert.equal(result.sent, true);
});

test("send failure is reported without a second send attempt or thrown fallback", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "Question"
  }, {
    persistTurn: async () => ({ id: "turn-1" }),
    runAgent: async () => "Answer",
    updateTurn: async () => { events.push("update"); },
    send: async () => { events.push("send"); throw new Error("socket closed"); },
    safeFallback: async () => { events.push("fallback"); return "Fallback"; }
  });
  assert.deepEqual(events, ["update", "send"]);
  assert.equal(result.sent, false);
  assert.match(result.deliveryError.message, /socket closed/u);
});

test("a throwing fallback provider uses a localized neutral fallback", async () => {
  const events = [];
  const result = await runAgentAfterPreflight({
    ...eligibleInput(), userId: "contact-1", sourceMessage: "Question", locale: "arabic"
  }, {
    persistTurn: async () => ({ id: "turn-1" }),
    runAgent: async () => { throw new Error("provider failed"); },
    updateTurn: async ({ patch }) => { events.push(["update", patch.response]); },
    send: async (response) => { events.push(["send", response]); },
    safeFallback: async () => { throw new Error("fallback failed"); }
  });
  assert.equal(events[0][1], "ما فيني أكّد هالشي هلأ. جرّب مرة تانية لاحقًا.");
  assert.equal(events[1][1], events[0][1]);
  assert.equal(result.sent, true);
});
