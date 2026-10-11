"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentLiveAnswerTurn } = require("./agentLiveAnswerTurn");

function makeStore() {
  const user = { id: "synthetic-live-answer", profile: {}, history: [] };
  let serial = 0;
  const events = [];
  const store = {
    ensureUser: async () => user,
    getUser: async () => user,
    updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response, extra) => {
      const turn = { id: `turn-${++serial}`, message, response, metadata: extra?.metadata || {} };
      user.history.push(turn);
      events.push(["persist", turn.id, message, response]);
      return turn;
    },
    updateHistoryTurn: async (_id, turnId, patch) => {
      const turn = user.history.find((item) => item.id === turnId);
      assert.ok(turn, "the final answer updates the persisted source turn");
      Object.assign(turn, patch);
      events.push(["update", turnId, patch.response, patch.metadata || null]);
      return turn;
    },
    saveQualification: async () => {},
    saveIntents: async () => {},
    searchKnowledge: async () => []
  };
  return { user, store, events };
}

test("import-safe live composition runs response gates, persists once, and sends one localized specialist offer", async () => {
  const { user, store, events } = makeStore();
  const sent = [];
  const typing = [];
  const result = await runAgentLiveAnswerTurn({
    socket: {}, chatId: "synthetic-chat", userId: user.id,
    text: "We need a large land development and a strategic partnership",
    providerMessageId: "synthetic-provider-id"
  }, {
    store,
    setTyping: async (_socket, _chat, value) => typing.push(value),
    sendStoredTextReply: async (_socket, _chat, response, userId, turn) => {
      sent.push({ response, userId, turnId: turn.id });
      events.push(["send", turn.id, response]);
    },
    embedText: async () => [0.1],
    agentOptions: {
      decideNextStep: async () => ({ type: "respond", text: "The approved test fixture confirms we can discuss your development opportunity." })
    }
  });

  assert.equal(result.outcome, "agent");
  assert.equal(result.delivered, true);
  assert.equal(result.persistenceUpdated, true);
  assert.deepEqual(typing, [true, false]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, user.id);
  assert.match(sent[0].response, /With your permission/u, "the grounded specialist hook remains consent based");
  assert.equal(user.history.length, 1);
  assert.equal(user.history[0].response, sent[0].response);
  assert.equal(user.history[0].metadata.specialistOffer?.consentRequired, true);
  assert.deepEqual(events.map(([event]) => event), ["persist", "update", "send"]);
});

test("live composition applies jurisdiction guard before persistence and reports ambiguous send failure without retry", async () => {
  const { user, store, events } = makeStore();
  let sendAttempts = 0;
  const logs = [];
  const result = await runAgentLiveAnswerTurn({
    socket: {}, chatId: "synthetic-chat", userId: user.id,
    text: "Compare Cyprus and Dubai"
  }, {
    store,
    setTyping: async () => {},
    sendStoredTextReply: async () => { sendAttempts += 1; throw new Error("synthetic transport failure after attempt"); },
    logEvent: async (event, fields) => logs.push([event, fields]),
    embedText: async () => [0.1],
    agentOptions: {
      decideNextStep: async () => ({ type: "respond", text: "Dubai has a coastline. Where are your clients, your bank, and your family?" })
    }
  });

  assert.equal(result.delivered, false);
  assert.equal(result.persistenceUpdated, true);
  assert.ok(result.responseLength > 0);
  assert.equal(sendAttempts, 1, "an uncertain provider send is never retried");
  assert.equal(user.history.length, 1);
  assert.equal(user.history[0].response.length, result.responseLength);
  assert.doesNotMatch(user.history[0].response, /Dubai has a coastline/u,
    "unsupported comparative claims are removed by the jurisdiction guard before saving");
  assert.ok(user.history[0].response.length > 0);
  assert.deepEqual(events.map(([event]) => event), ["persist", "update"]);
  assert.deepEqual(logs.map(([event]) => event), ["agent_reply_delivery_failed"]);
});

test("live composition records a failed final persistence patch without leaking customer text or retrying", async () => {
  const { user, store } = makeStore();
  store.updateHistoryTurn = async () => { throw new Error("synthetic database outage"); };
  const logs = [];
  const sent = [];
  const result = await runAgentLiveAnswerTurn({
    socket: {}, chatId: "synthetic-chat", userId: user.id, text: "Tell me about your services"
  }, {
    store,
    setTyping: async () => {},
    sendStoredTextReply: async (_socket, _chat, response) => sent.push(response),
    logEvent: async (event, fields) => logs.push([event, fields]),
    embedText: async () => [0.1],
    agentOptions: { decideNextStep: async () => ({ type: "respond", text: "I can help with that. Which area matters most to you?" }) }
  });

  assert.equal(result.delivered, true);
  assert.equal(result.persistenceUpdated, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /can’t confirm that right now/iu, "a neutral fallback is sent after the update failure");
  assert.equal(user.history.length, 1, "the already-persisted pending turn is never inserted again");
  assert.deepEqual(logs.map(([event]) => event), ["agent_reply_persistence_failed"]);
  assert.deepEqual(logs[0][1], { persistenceUpdated: false, delivered: true });
});

test("pending appointment confirmation remains outside the live Agent answer path", async () => {
  const { user, store } = makeStore();
  user.booking = { status: "awaiting_confirmation" };
  let sends = 0;
  await assert.rejects(runAgentLiveAnswerTurn({
    socket: {}, chatId: "synthetic-chat", userId: user.id, text: "yes, confirm it"
  }, {
    store,
    sendStoredTextReply: async () => { sends += 1; }
  }), /deterministic booking workflow/u);
  assert.equal(user.history.length, 0);
  assert.equal(sends, 0, "no appointment confirmation is claimed or sent by this path");
});

test("live composition passes a genuine unanswered prior assistant question into the decision context", async () => {
  const { user, store } = makeStore();
  user.history.push({
    id: "prior-turn",
    message: "I want to register a company.",
    response: "What business activity will the company have?"
  });
  let seenQuestion = null;
  await runAgentLiveAnswerTurn({
    socket: {}, chatId: "synthetic-chat", userId: user.id, text: "Consulting services"
  }, {
    store,
    setTyping: async () => {},
    sendStoredTextReply: async () => {},
    embedText: async () => [0.1],
    agentOptions: {
      decideNextStep: async ({ context }) => {
        seenQuestion = context.currentOpenQuestion;
        return { type: "respond", text: "Thanks, I understand the planned activity is consulting services." };
      }
    }
  });

  assert.equal(seenQuestion, "What business activity will the company have?");
});
