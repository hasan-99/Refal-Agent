const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeApiStore } = require("./supabaseStore");
const { MemoryStore } = require("./store");
const { buildConversationContext } = require("./conversationMemory");
const { recordHistory } = require("./messageRouter");
const { hasAutomatedReminderPermission } = require("./leadQualification");

test("response style reads are bounded and cached, and a save refreshes the cache", async (t) => {
  const store = new EdgeApiStore({ apiUrl: "https://example.invalid/functions/v1/rafa-agent-api", key: "public-test-key", apiSecret: "test-secret" });
  const originalFetch = global.fetch;
  const calls = [];
  let saved = { paragraphLength: "short", listMarker: "hyphen", boldLabels: true };
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method || "GET", signal: options.signal });
    if (options.method === "PUT") saved = JSON.parse(options.body).style;
    return Response.json({ style: saved });
  };
  t.after(() => { global.fetch = originalFetch; });

  const first = await store.getResponseStyle();
  const second = await store.getResponseStyle();
  assert.deepEqual(first, saved);
  assert.deepEqual(second, saved);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/settings\/response-style$/u);

  const next = { paragraphLength: "very_short", listMarker: "numbered", boldLabels: false };
  assert.deepEqual(await store.updateResponseStyle(next), next);
  assert.deepEqual(await store.getResponseStyle(), next);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "PUT");
});

test("response style reads allow a dashboard-sized timeout without changing the fast customer default", async () => {
  const store = new EdgeApiStore({ apiUrl: "https://example.invalid/functions/v1/rafa-agent-api", key: "public-test-key", apiSecret: "test-secret" });
  const calls = [];
  store.request = async (path, options) => { calls.push({ path, ...options }); return { style: { paragraphLength: "short" } }; };
  await store.getResponseStyle();
  store.responseStyleCache = null;
  await store.getResponseStyle({ timeoutMs: 8000 });
  assert.equal(calls[0].timeoutMs, 1200, "customer turns keep a short settings lookup bound");
  assert.equal(calls[1].timeoutMs, 8000, "dashboard admins can load settings across an Edge cold start");
  assert.equal(calls.every((call) => call.attempts === 1), true);
});

test("company identity settings are validated, cached briefly, and refreshed after an admin save", async () => {
  const store = new EdgeApiStore({ apiUrl: "https://example.invalid/functions/v1/rafa-agent-api", key: "public-test-key", apiSecret: "test-secret" });
  const { identityFromProfile } = require("./companyIdentitySettings");
  const { profile } = require("./companyProfile");
  const initial = identityFromProfile(profile);
  let saved = initial;
  const calls = [];
  store.request = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", timeoutMs: options.timeoutMs });
    if (options.method === "PUT") saved = JSON.parse(options.body).identity;
    return { identity: saved };
  };

  assert.deepEqual(await store.getCompanyIdentity(), initial);
  assert.deepEqual(await store.getCompanyIdentity(), initial);
  assert.equal(calls.length, 1);
  const changed = { ...initial, brand: "REFAL Demo" };
  assert.deepEqual(await store.updateCompanyIdentity(changed), changed);
  assert.deepEqual(await store.getCompanyIdentity(), changed);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "PUT");
});

test("business guidance is loaded from its own settings key, cached, and refreshed after save", async () => {
  const store = new EdgeApiStore({ apiUrl: "https://example.invalid/functions/v1/rafa-agent-api", key: "public-test-key", apiSecret: "test-secret" });
  const calls = [];
  let saved = { rules: [], hooks: [] };
  store.request = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", timeoutMs: options.timeoutMs, body: options.body });
    if (options.method === "PUT") saved = JSON.parse(options.body).guidance;
    return { guidance: saved };
  };
  assert.deepEqual(await store.getBusinessGuidance(), saved);
  assert.deepEqual(await store.getBusinessGuidance(), saved);
  assert.equal(calls.length, 1);
  const next = { rules: [{ id: "rule-1", title: "Answer first", language: "all", instruction: "Answer before qualifying.", enabled: true }], hooks: [] };
  assert.deepEqual(await store.updateBusinessGuidance(next), next);
  assert.deepEqual(await store.getBusinessGuidance(), next);
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /settings\/business-guidance$/u);
  assert.equal(calls[1].method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].body), { guidance: next });
});

test("MemoryStore preserves consent provenance and binds it to the inserted turn", async () => {
  const store = new MemoryStore();
  const at = "2026-10-10T10:00:00.000Z";
  const { turn } = await recordHistory(store, "contact-1", "Yes, please send automated reminders", "Understood. Automated reminders are enabled for this request.", {
    at,
    metadata: {
      intent: { language: "english" },
      automatedReminderConsent: {
        state: "granted",
        purpose: "automated_reminder",
        scope: "automated_reminder",
        offerSourceTurnId: "offer-turn",
        language: "en",
        channel: "whatsapp",
        observedAt: at
      }
    }
  });

  assert.match(turn.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(turn.at, at);
  assert.equal(turn.source, "whatsapp");
  assert.equal(turn.automated, true);
  assert.equal(turn.metadata.followUpConsent.sourceTurnId, turn.id);
  assert.equal(hasAutomatedReminderPermission(store.getUser("contact-1")), true);
});

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

test("logEvent redacts contact identifiers, personal fields, and embedded secrets before the API request", async () => {
  const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
  let payload;
  store.request = async (path, options) => {
    assert.equal(path, "/events");
    payload = JSON.parse(options.body);
    return { ok: true };
  };
  await store.logEvent("appointment_admin_rejected", {
    action: "reject",
    contactId: "123456789@s.whatsapp.net",
    reviewer: "operator@example.test",
    reason: "Customer asked for deletion",
    details: { state: "failed", error: "password: SecretPhrase-81" }
  });
  assert.deepEqual(payload.fields, {
    action: "reject",
    contactId: "[redacted]",
    reviewer: "[redacted]",
    reason: "[redacted]",
    details: { state: "failed", error: "[redacted]" }
  });
  assert.doesNotMatch(JSON.stringify(payload), /123456789|operator@example|Customer asked|SecretPhrase/u);
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

test("MemoryStore conversation reset forgets names and interests while retaining safety settings", () => {
  const store = new MemoryStore();
  const userId = "123@s.whatsapp.net";
  const user = store.ensureUser(userId);
  user.profile = {
    name: "Karim", nameSource: "customer_stated", conversationSummary: "Wants a company",
    agentFacts: { businessactivity: { value: "Consulting" } },
    followUpBlocked: true,
    conversationPreferences: { noProactiveBookingOrContact: true, preferredReplyStyle: "old" }
  };
  user.booking = { status: "awaiting_details" };
  user.consent = { followUp: "granted" };
  store.addHistory(userId, "مرحبا انا كريم", "أهلا أستاذ كريم");

  assert.deepEqual(store.deleteConversation(userId), { deleted: true, deletedTurns: 1 });
  const fresh = store.getUser(userId);
  assert.deepEqual(fresh.history, []);
  assert.deepEqual(fresh.profile, {
    followUpBlocked: true,
    conversationPreferences: { noProactiveBookingOrContact: true }
  });
  assert.equal(fresh.booking, null);
  assert.deepEqual(fresh.consent, { followUp: "revoked" });
  assert.equal(fresh.step, "name");
  const context = buildConversationContext(fresh, { currentMessage: "مرحبا" });
  assert.doesNotMatch(context.summary, /Karim|كريم|Consulting|company/iu);
});

test("deleteConversation invalidates the entire cached user after a server-side reset", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ deleted: true, deletedTurns: 2 }) };
  };

  try {
    const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
    const userId = "123@s.whatsapp.net";
    store.data.users[userId] = { id: userId, profile: { name: "Karim", conversationSummary: "Old question" }, history: [{ message: "hello" }, { message: "services?" }] };
    const result = await store.deleteConversation(userId);

    assert.deepEqual(result, { deleted: true, deletedTurns: 2 });
    assert.equal(request.url, "https://example.test/rafa-agent-api/contacts/123%40s.whatsapp.net/conversation");
    assert.equal(request.options.method, "DELETE");
    assert.equal(request.options.headers["x-rafa-api-secret"], "internal-secret");
    assert.equal(store.data.users[userId], undefined, "old profile and history must not be reused");
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
