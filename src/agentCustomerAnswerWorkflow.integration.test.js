"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareInboundMessage, routeMessageResult } = require("./messageRouter");
const { runAgentAfterPreflight } = require("./agentWhatsAppAdapter");
const { runAgentTurnForContact } = require("./agentRuntime");
const { buildRecentConversation } = require("./agentShadow");

// Local vertical-path integration: real inbound preparation, deterministic
// classifier/router, Agent runtime/retrieval and answer policy, plus a fake
// durable store and fake WhatsApp sender. No network, provider, dashboard,
// Supabase, or live customer data is involved.
const scenarios = [
  {
    language: "English",
    locale: "english",
    question: "What does company formation include in Cyprus?",
    priorTurns: [{ message: "I'm considering setting up a business in Cyprus.", response: "I can explain the approved company formation information." }],
    answer: "The approved test fixture says company formation includes registration and initial setup support. What business activity are you considering?"
  },
  {
    language: "Arabic",
    locale: "arabic",
    question: "شو بتشمل خدمة تأسيس شركة بقبرص؟",
    priorTurns: [{ message: "عم فكر أفتح شركة بقبرص.", response: "فيني وضّح المعلومات المعتمدة عن تأسيس الشركات." }],
    answer: "حسب المعلومات المعتمدة للاختبار، يشمل تأسيس الشركة التسجيل ودعم الإعداد الأولي. شو النشاط التجاري اللي عم تفكر فيه؟"
  },
  {
    language: "Greek",
    locale: "greek",
    question: "Τι περιλαμβάνει η σύσταση εταιρείας στην Κύπρο;",
    priorTurns: [{ message: "Σκέφτομαι να ιδρύσω επιχείρηση στην Κύπρο.", response: "Μπορώ να εξηγήσω τις εγκεκριμένες πληροφορίες για τη σύσταση εταιρείας." }],
    answer: "Σύμφωνα με το εγκεκριμένο δοκιμαστικό περιεχόμενο, η σύσταση περιλαμβάνει εγγραφή και αρχική υποστήριξη. Ποια δραστηριότητα σκέφτεστε για την εταιρεία;"
  },
  {
    language: "English contextual follow-up",
    locale: "english",
    question: "What does that include?",
    priorTurns: [{ message: "I want to form a company in Cyprus.", response: "I can explain the approved company formation information." }],
    contextualQuestion: "I want to form a company in Cyprus.",
    answer: "The approved test fixture says company formation includes registration and initial setup support. What business activity are you considering?"
  },
  {
    language: "Arabic contextual follow-up",
    locale: "arabic",
    question: "شو بيشمل؟",
    priorTurns: [{ message: "بدي أسس شركة بقبرص.", response: "فيني أوضح لك المعلومات المعتمدة عن تأسيس الشركة." }],
    contextualQuestion: "بدي أسس شركة بقبرص.",
    answer: "حسب المعلومات المعتمدة للاختبار، يشمل تأسيس الشركة التسجيل ودعم الإعداد الأولي. شو النشاط التجاري اللي عم تفكر فيه؟"
  },
  {
    language: "Greek contextual follow-up",
    locale: "greek",
    question: "Τι περιλαμβάνει;",
    priorTurns: [{ message: "Θέλω να ιδρύσω εταιρεία στην Κύπρο.", response: "Μπορώ να εξηγήσω τις εγκεκριμένες πληροφορίες για τη σύσταση εταιρείας." }],
    contextualQuestion: "Θέλω να ιδρύσω εταιρεία στην Κύπρο.",
    answer: "Σύμφωνα με το εγκεκριμένο δοκιμαστικό περιεχόμενο, η σύσταση περιλαμβάνει εγγραφή και αρχική υποστήριξη. Ποια δραστηριότητα σκέφτεστε για την εταιρεία;"
  },
];

for (const scenario of scenarios) test(`${scenario.language} inbound company question is classified, routed, answered from approved fixture, and saved for history view`, async () => {
  const userId = "synthetic-contact-1";
  const { question, answer } = scenario;
  const events = [];
  let retrievedQuery = "";
  const user = { id: userId, profile: {}, history: (scenario.priorTurns || []).map((turn, index) => ({ id: `prior-turn-${index + 1}`, ...turn })) };
  let nextTurn = 0;
  const store = {
    ensureUser: async () => user,
    getUser: async () => user,
    updateUser: async (_id, updater) => updater(user),
    addHistory: async (_id, message, response, extra) => {
      const turn = { id: `synthetic-turn-${++nextTurn}`, message, response, metadata: extra?.metadata || {} };
      user.history.push(turn);
      events.push(["save", turn.id]);
      return turn;
    },
    updateHistoryTurn: async (_id, turnId, patch) => {
      const turn = user.history.find((row) => row.id === turnId);
      assert.ok(turn, "Agent updates the same saved source turn");
      Object.assign(turn, patch);
      events.push(["update", turnId]);
      return turn;
    },
    saveQualification: async () => {},
    saveIntents: async () => {},
    searchKnowledge: async (query) => {
      retrievedQuery = query;
      events.push(["approved-retrieval", query]);
      return [{ chunk_id: "fixture-company-formation", source_name: "Synthetic approved test fixture", heading: "Company formation", content: answer,
        review_status: "approved", valid_until: "2099-01-01T00:00:00.000Z", metadata: { facts: [] } }];
    }
  };

  const prepared = await prepareInboundMessage({ userId, incoming: question, user, store });
  const routed = await routeMessageResult({ userId, text: question, store, existingUser: user, preparedInbound: prepared });
  assert.equal(routed.shouldUseAi, true);
  assert.ok(prepared.classification.intents.length > 0, `classified intents: ${prepared.classification.intents.join(", ")}`);
  assert.equal(prepared.classification.language, scenario.locale, "the inbound path detects the customer's actual language");

  const sent = [];
  const result = await runAgentAfterPreflight({
    prepared, routed, userId, sourceMessage: question,
    locale: prepared.classification.language,
    metadata: prepared.metadata
  }, {
    persistTurn: async ({ message, response, metadata }) => store.addHistory(userId, message, response, { metadata }),
    runAgent: async ({ sourceTurnId, allowedCapabilities }) => {
      events.push(["agent", sourceTurnId]);
      const runtime = await runAgentTurnForContact({
        currentMessage: question,
        locale: prepared.classification.language,
        contact: { id: userId, name: null },
        recentConversation: buildRecentConversation(user.history.filter((turn) => turn.id !== sourceTurnId)),
        store,
        user,
        userId,
        intents: routed.metadata?.intent?.intents || prepared.classification.intents,
        language: prepared.classification.language,
        sourceTurnId,
        allowedCapabilities,
        embedText: async () => [0.1]
      }, {
        decideNextStep: async ({ context, observations }) => {
          assert.deepEqual(context.recentConversation, buildRecentConversation(user.history.filter((turn) => turn.id !== sourceTurnId)));
          const evidence = observations[0]?.result?.modelObservation?.evidence || [];
          assert.ok(evidence.some((item) => item.content === answer));
          return { type: "respond", text: answer };
        }
      });
      return runtime.response;
    },
    updateTurn: ({ turnId, patch }) => store.updateHistoryTurn(userId, turnId, patch),
    send: async (text, turn) => { sent.push({ text, turnId: turn?.id }); events.push(["send", turn?.id]); }
  });

  assert.equal(result.route, "agent");
  assert.equal(result.sent, true);
  assert.equal(result.persistenceUpdated, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, answer);
  assert.match(answer, /[?؟;;]$/u, "the grounded reply offers one useful next question");
  if (scenario.contextualQuestion) {
    assert.ok(retrievedQuery.includes(scenario.contextualQuestion), "retrieval query resolves the follow-up against the earlier customer topic");
    assert.ok(retrievedQuery.includes(question), "retrieval query retains the customer's current question");
  }
  const persisted = user.history.find((turn) => turn.id === sent[0].turnId);
  assert.equal(persisted.message, question);
  assert.equal(persisted.response, answer);
  // A history-backed dashboard can see the final saved row. This asserts only
  // the local persistence contract; it does not exercise dashboard UI/API.
  assert.deepEqual(events.map(([name]) => name), ["save", "agent", "approved-retrieval", "update", "send"]);
});
