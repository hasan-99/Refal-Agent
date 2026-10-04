const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSafeRequestFromPrivacyMessage } = require("./privacyIntent");
const { routeMessageResult, recordHistory } = require("./messageRouter");

test("privacy routing can keep a separate safe service question without retaining a credential clause", () => {
  const result = extractSafeRequestFromPrivacyMessage("My fake password is FAKE-ONLY-Secret-7241. Can you help me set up a company?");
  assert.equal(result, "Can you help me set up a company?");
  assert.doesNotMatch(result, /password|FAKE-ONLY-Secret-7241/i);
});

test("privacy routing drops a turn containing only sensitive data", () => {
  assert.equal(extractSafeRequestFromPrivacyMessage("IBAN CY00 0000 0000 0000 0000 0000 0000. OTP 123456."), "");
});

test("privacy routing refuses to pass through an additional restricted request", () => {
  assert.equal(extractSafeRequestFromPrivacyMessage("Password: secret. Will the bank approve my mortgage?"), "");
});

test("a secret-bearing turn can still route its separate safe request without persisting the original text", async () => {
  const user = { id: "privacy-routing-test", phone: "", profile: {}, history: [] };
  const store = {
    ensureUser: async () => user,
    getUser: async () => user,
    updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response, extra) => {
      const turn = { id: "privacy-turn-1", message, response, metadata: extra?.metadata || {} };
      user.history.push(turn);
      return turn;
    }
  };
  const input = "My fake password is FAKE-ONLY-Secret-7241. Can you help me set up a company?";
  const result = await routeMessageResult({ userId: user.id, text: input, store });
  assert.equal(result.shouldUseAi, true);
  assert.equal(result.metadata.privacySafeQuestion, "Can you help me set up a company?");
  assert.ok(result.metadata.safety.risks.includes("privacy"));
  await recordHistory(store, user.id, input, result.response, { metadata: result.metadata });
  assert.equal(user.history[0].message, "[message omitted: potentially sensitive credentials]");
  assert.doesNotMatch(JSON.stringify(user.history), /FAKE-ONLY-Secret-7241/);
  assert.doesNotMatch(JSON.stringify(user.history[0].metadata), /privacySafeQuestion/);
});
