const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeApiStore } = require("./supabaseStore");

test("addHistory returns the inserted turn including its ID", async () => {
  const originalFetch = global.fetch;
  const insertedTurn = { id: "inserted-turn-id", message: "Hi", response: "Hello" };
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      turn: insertedTurn,
      user: { id: "123@s.whatsapp.net", history: [] }
    })
  });

  try {
    const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
    const result = await store.addHistory("123@s.whatsapp.net", "Hi", "Hello");
    assert.equal(result.id, "inserted-turn-id");
    assert.equal(result, insertedTurn);
  } finally {
    global.fetch = originalFetch;
  }
});

test("addHistory redacts credential and payment data before the Supabase request", async () => {
  const originalFetch = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ turn: { id: "redacted-turn", ...payload }, user: { id: "123@s.whatsapp.net", history: [] } }) };
  };
  try {
    const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
    await store.addHistory("123@s.whatsapp.net", "password: SecretPhrase-81 card 4111111111111111", "Please use a secure channel.");
    assert.doesNotMatch(payload.message, /SecretPhrase-81|4111111111111111/);
    assert.match(payload.message, /\[redacted\]/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("updateHistoryTurn sends a scoped PATCH and returns the saved turn", async () => {
  const originalFetch = global.fetch;
  let request;
  const savedTurn = { id: "turn-id", response: "Updated reply", metadata: { delivery: { status: "sent" } } };
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ turn: savedTurn }) };
  };

  try {
    const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
    store.data.users["123@s.whatsapp.net"] = {
      history: [{ id: "turn-id", response: "Old reply" }]
    };
    const patch = { response: "Updated reply", metadata: { delivery: { status: "sent" } } };

    const result = await store.updateHistoryTurn("123@s.whatsapp.net", "turn-id", patch);

    assert.equal(result, savedTurn);
    assert.equal(request.url, "https://example.test/rafa-agent-api/contacts/123%40s.whatsapp.net/history/turn-id");
    assert.equal(request.options.method, "PATCH");
    assert.deepEqual(JSON.parse(request.options.body), patch);
    assert.equal(store.data.users["123@s.whatsapp.net"].history[0], savedTurn);
    assert.equal(request.options.headers["x-rafa-api-secret"], "internal-secret");
  } finally {
    global.fetch = originalFetch;
  }
});

test("deleteConversation removes only the saved transcript and targets the conversation endpoint", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ deleted: true, deletedTurns: 2 }) };
  };

  try {
    const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
    const userId = "123@s.whatsapp.net";
    store.data.users[userId] = { id: userId, history: [{ message: "hello" }, { message: "services?" }] };
    const result = await store.deleteConversation(userId);

    assert.deepEqual(result, { deleted: true, deletedTurns: 2 });
    assert.equal(request.url, "https://example.test/rafa-agent-api/contacts/123%40s.whatsapp.net/conversation");
    assert.equal(request.options.method, "DELETE");
    assert.equal(request.options.headers["x-rafa-api-secret"], "internal-secret");
    assert.deepEqual(store.data.users[userId].history, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test("updateUser persists an explicitly captured customer name in the contact profile", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  const userId = "123@s.whatsapp.net";
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (String(url).endsWith("/contacts/ensure")) {
      return { ok: true, json: async () => ({ user: { id: userId, profile: {}, whatsapp: {}, history: [] } }) };
    }
    return { ok: true, json: async () => ({ user: { id: userId, profile: { name: "Rami Haddad" }, whatsapp: {}, history: [] } }) };
  };

  try {
    const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
    const saved = await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}), name: "Rami Haddad" };
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.method, "PUT");
    assert.equal(JSON.parse(requests[1].options.body).profile.name, "Rami Haddad");
    assert.equal(saved.profile.name, "Rami Haddad");
    assert.equal(store.data.users[userId].profile.name, "Rami Haddad");
  } finally {
    global.fetch = originalFetch;
  }
});
