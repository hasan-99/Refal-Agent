const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeApiStore } = require("./supabaseStore");

test("workflow store methods use protected normalized workflow endpoints", async () => {
  const calls = [];
  const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
  store.request = async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith("/qualification")) return { qualification: { id: "q-1" } };
    if (path.endsWith("/intents")) return { intents: [{ intent: "investment" }] };
    if (path.endsWith("/consent")) return { consent: { state: "granted" } };
    if (path.endsWith("/follow-up")) return { followUp: { status: "eligible" } };
    if (path.endsWith("/handover")) return { handover: { id: "h-1" } };
    if (path.endsWith("/priority-alert")) return { alert: { id: "a-1" } };
    if (path.endsWith("/complaint")) return { complaint: { id: "c-1" } };
    if (path.endsWith("/existing-client-verification")) return { verification: { state: "authenticated" } };
    return { auditEvent: { id: "e-1" } };
  };

  assert.deepEqual(await store.saveQualification("123@s.whatsapp.net", { need: 3, value: 2, timing: 1, authority: 0, readiness: 0, fit: 2 }), { id: "q-1" });
  assert.deepEqual(await store.saveIntents("123@s.whatsapp.net", ["investment"]), [{ intent: "investment" }]);
  assert.deepEqual(await store.saveConsent("123@s.whatsapp.net", "granted"), { state: "granted" });
  assert.deepEqual(await store.saveFollowUpState("123@s.whatsapp.net", { consentState: "granted", status: "eligible" }), { status: "eligible" });
  assert.deepEqual(await store.createHandover("123@s.whatsapp.net", { department: "investment" }), { id: "h-1" });
  assert.deepEqual(await store.createPriorityAlert("123@s.whatsapp.net", { level: "high", trigger: "institutional_investment" }), { id: "a-1" });
  assert.deepEqual(await store.createComplaint("123@s.whatsapp.net", { severity: "high", summary: "A complaint" }), { id: "c-1" });
  assert.deepEqual(await store.saveExistingClientVerification("123@s.whatsapp.net", { state: "authenticated" }), { state: "authenticated" });
  assert.deepEqual(await store.logAuditEvent("123@s.whatsapp.net", "workflow_saved"), { id: "e-1" });
  assert.deepEqual(calls.map((call) => call.path), [
    "/workflows/qualification", "/workflows/intents", "/workflows/consent", "/workflows/follow-up",
    "/workflows/handover", "/workflows/priority-alert", "/workflows/complaint", "/workflows/existing-client-verification", "/workflows/audit-event"
  ]);
});

test("workflow persistence does not include evidence or memory fields", async () => {
  const store = new EdgeApiStore({ apiUrl: "https://example.test/rafa-agent-api", key: "public-key", apiSecret: "internal-secret" });
  let body;
  store.request = async (_path, options) => { body = JSON.parse(options.body); return { qualification: body }; };
  await store.saveQualification("123@s.whatsapp.net", { need: 1, value: 1, timing: 1, authority: 1, readiness: 1, fit: 1 }, { evidence: "caller claim", memories: ["caller memory"] });
  assert.equal(Object.hasOwn(body, "evidence"), false);
  assert.equal(Object.hasOwn(body, "memories"), false);
});
