const assert = require("node:assert/strict");
const { test } = require("node:test");
const { extractCustomerName, extractCustomerNeed, routeMessageResult } = require("./messageRouter.js");

test("customer names are extracted from common English and Arabic introductions", () => {
  assert.equal(extractCustomerName("My name is Rami"), "Rami");
  assert.equal(extractCustomerName("I'm Rami"), "Rami");
  assert.equal(extractCustomerName("اسمي حسن"), "حسن");
  assert.equal(extractCustomerName("أنا اسمي ليلى"), "ليلى");
  assert.equal(extractCustomerName("كيفك"), null);
});

test("explicit customer service interest is saved as personal memory, not mistaken for a name", async () => {
  assert.equal(extractCustomerNeed("I'm interested in property management"), "property management");
  assert.equal(extractCustomerNeed("بدي مساعدة في إدارة العقارات"), "إدارة العقارات");
  const user = { id: "35799123456@s.whatsapp.net", profile: {}, history: [] };
  const store = {
    ensureUser: async () => user,
    updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response) => { user.history.push({ message, response }); return user.history.at(-1); }
  };
  const result = await routeMessageResult({ userId: user.id, text: "I'm interested in property management", store });
  assert.equal(user.profile.need, "property management");
  assert.equal(user.profile.name, undefined);
  assert.equal(result.shouldUseAi, true);
});

test("كيفك receives natural Arabic small talk and answers first without a name prompt", async () => {
  const user = { id: "35799123456@s.whatsapp.net", profile: {}, history: [] };
  const store = {
    ensureUser: async () => user,
    addHistory: async (_id, message, response) => { user.history.push({ message, response }); return user.history.at(-1); }
  };
  const routed = await routeMessageResult({ userId: user.id, text: "كيفك", store });
  assert.match(routed.response, /الحمد لله/);
  assert.doesNotMatch(routed.response, /ما اسمك/);
  assert.doesNotMatch(routed.response, /https?:\/\/|Sources:/i);
  assert.equal(routed.shouldUseAi, false);
});

function integrationStore(user) {
  return {
    ensureUser: async () => user,
    getUser: async () => user,
    updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response, extra) => {
      const turn = { message, response, metadata: extra?.metadata || {} };
      user.history.push(turn);
      return turn;
    }
  };
}

test("routeMessageResult persists multi-intent routing, qualification, and a durable handover", async () => {
  const user = { id: "35799123456@s.whatsapp.net", phone: "35799123456", profile: {}, history: [] };
  const result = await routeMessageResult({
    userId: user.id,
    text: "We need a large land development and a strategic partnership",
    store: integrationStore(user)
  });
  assert.equal(result.shouldUseAi, false);
  assert.equal(result.metadata.intent.isMultiIntent, true);
  assert.ok(result.metadata.intent.intents.includes("land_development"));
  assert.ok(result.metadata.intent.intents.includes("partnership"));
  assert.ok(result.metadata.qualification.dimensions && Object.keys(result.metadata.qualification.dimensions).length === 6);
  assert.equal(result.handover.routing.handoverRequired, true);
  assert.match(result.response, /specialist/i);
  assert.doesNotMatch(result.response, /Priority|qualification|score|REFAL LEAD SUMMARY/i);
  assert.equal(user.history[0].metadata.handover.summary.priority, "high");
});

test("routeMessageResult handles a regulated Greek request locally and never falls through to AI", async () => {
  const user = { id: "35799123456@s.whatsapp.net", phone: "35799123456", profile: {}, history: [] };
  const result = await routeMessageResult({ userId: user.id, text: "Μπορεί η τράπεζα να εγκρίνει σίγουρα το δάνειο;", store: integrationStore(user) });
  assert.equal(result.shouldUseAi, false);
  assert.match(result.response, /Δεν μπορώ|Refalco/i);
  assert.doesNotMatch(result.response, /I can’t|I cannot|Before we continue/i);
  assert.ok(result.metadata.safety.risks.includes("banking"));
});

test("complaints and existing-client messages create handovers without exposing internal summaries", async () => {
  for (const text of ["I want to make a complaint about the delay", "I am an existing client and need my contract"]) {
    const user = { id: "35799123456@s.whatsapp.net", phone: "35799123456", profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(result.shouldUseAi, false);
    assert.ok(result.handover);
    assert.doesNotMatch(result.response, /Severity|Customer:|REFAL LEAD SUMMARY|score/i);
  }
});
