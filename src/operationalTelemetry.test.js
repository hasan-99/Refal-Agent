const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildOperationalEvent, safeErrorDiagnostics } = require("./operationalTelemetry");

test("operational events retain trace stages but remove customer and provider identifiers or content", () => {
  const event = buildOperationalEvent("response_stage", {
    traceId: "1c3ba6c2-55f2-4c5e-9cc0-c42008333444",
    stage: "knowledge_retrieval",
    durationMs: 126,
    evidenceCount: 3,
    userId: "35799123456@s.whatsapp.net",
    contactId: "contact-123",
    sourceTurnId: "turn-123",
    messageId: "provider-message-123",
    remoteJid: "35799123456@s.whatsapp.net",
    pushName: "Sensitive Customer Name",
    body: "I need help with my company and phone +357 99123456",
    nested: {
      chatId: "35799123456@lid",
      phoneNumber: "+357 99123456",
      message: "My private message is confidential",
      errorMessage: "token=secret-value-12345"
    }
  });
  const serialized = JSON.stringify(event);

  assert.equal(event.fields.traceId, "1c3ba6c2-55f2-4c5e-9cc0-c42008333444");
  assert.equal(event.fields.stage, "knowledge_retrieval");
  assert.equal(event.fields.durationMs, 126);
  assert.equal(event.fields.evidenceCount, 3);
  for (const privateValue of ["35799123456", "contact-123", "turn-123", "provider-message-123", "Sensitive Customer Name", "confidential", "secret-value-12345"]) {
    assert.equal(serialized.includes(privateValue), false, `leaked ${privateValue}`);
  }
});

test("AI usage events keep aggregate accounting metrics but never persist a customer identifier", () => {
  let storedEvent;
  const persistViaSanitizedLogger = (event, fields) => {
    storedEvent = buildOperationalEvent(event, fields);
    return storedEvent;
  };
  const usage = {
    source: "whatsapp",
    userId: "35799123456@s.whatsapp.net",
    model: "approved-provider/model",
    promptTokens: 321,
    completionTokens: 45,
    totalTokens: 366,
    costUsd: 0.00042
  };

  persistViaSanitizedLogger("ai_usage", usage);

  assert.equal(storedEvent.event, "ai_usage");
  assert.equal(storedEvent.fields.model, usage.model);
  assert.equal(storedEvent.fields.promptTokens, 321);
  assert.equal(storedEvent.fields.completionTokens, 45);
  assert.equal(storedEvent.fields.totalTokens, 366);
  assert.equal(storedEvent.fields.costUsd, 0.00042);
  assert.equal(Object.hasOwn(storedEvent.fields, "userId"), false);
  assert.doesNotMatch(JSON.stringify(storedEvent), /35799123456|@s\.whatsapp\.net/);
});

test("provider exception diagnostics retain safe codes only and never raw messages", () => {
  const diagnostics = safeErrorDiagnostics(Object.assign(new Error("Rami called from +357 99123456 with token=sk-secretvalue123456789"), {
    code: "ERR_PROVIDER_TIMEOUT",
    statusCode: 504
  }));
  const serialized = JSON.stringify(diagnostics);
  assert.deepEqual(diagnostics, { errorName: "Error", errorCode: "ERR_PROVIDER_TIMEOUT", statusCode: 504 });
  assert.doesNotMatch(serialized, /Rami|99123456|sk-secretvalue|token/i);
});
