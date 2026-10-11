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
    costUsd: 0.00042,
    providerLatencyMs: 842
  };

  persistViaSanitizedLogger("ai_usage", usage);

  assert.equal(storedEvent.event, "ai_usage");
  assert.equal(storedEvent.fields.model, usage.model);
  assert.equal(storedEvent.fields.promptTokens, 321);
  assert.equal(storedEvent.fields.completionTokens, 45);
  assert.equal(storedEvent.fields.totalTokens, 366);
  assert.equal(storedEvent.fields.costUsd, 0.00042);
  assert.equal(storedEvent.fields.providerLatencyMs, 842);
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

test("Agent model latency event keeps only the duration measurement", () => {
  const event = buildOperationalEvent("agent_model_call", {
    durationMs: 734,
    message: "private request content",
    prompt: "hidden system prompt"
  });
  assert.deepEqual(event, { event: "agent_model_call", fields: { durationMs: 734 } });
});

test("Agent turn diagnostics retain the outcome enum used by the operations dashboard", () => {
  const event = buildOperationalEvent("agent_turn_not_clean", {
    outcome: "safe_fallback",
    reasonCode: "knowledge_unavailable",
    stepCount: 2,
    customerText: "private request"
  });
  assert.deepEqual(event.fields, {
    outcome: "safe_fallback",
    reasonCode: "knowledge_unavailable",
    stepCount: 2
  });
});

test("Agent trace preserves reason codes, tool/search outcomes, evidence references, and redacts sensitive query values", () => {
  const event = buildOperationalEvent("agent_tool_call", {
    step: 2, tool: "searchApprovedKnowledge", status: "found", reasonCode: "RETRIEVAL_OK",
    query: "ممكم اعرف شو بتقدمو خدمات؟ رقم الحساب: CY12000000000000000000000000 +357 99123456",
    searchQueries: ["Refalco Group service overview", "ممكم اعرف شو بتقدمو خدمات؟ +357 99123456"],
    resultCount: 8, evidenceCount: 3,
    evidenceIds: ["088fbb8a-65bc-414a-8684-a3423acf0030", "9ee12163-73b8-4833-89ce-62583e2a1b64"],
    privateMessage: "do not persist"
  });
  assert.equal(event.fields.reasonCode, "RETRIEVAL_OK");
  assert.equal(event.fields.tool, "searchApprovedKnowledge");
  assert.equal(event.fields.resultCount, 8);
  assert.equal(event.fields.evidenceIds.length, 2);
  assert.match(event.fields.query, /ممكم اعرف شو بتقدمو خدمات/u);
  assert.equal(event.fields.searchQueries.length, 2);
  assert.match(event.fields.searchQueries[1], /ممكم اعرف شو بتقدمو خدمات/u);
  assert.doesNotMatch(JSON.stringify(event), /99123456|CY12000000000000000000000000|do not persist/u);
});

test("operational telemetry drops unknown free-text fields even when they contain no detectable PII", () => {
  const event = buildOperationalEvent("agent_turn_completed", {
    stage: "model_generation",
    durationMs: 212,
    customerContext: "I want to register a holding company for my family",
    note: "Please call me tomorrow about the property",
    nested: { explanation: "The model should recommend the premium package" }
  });
  assert.deepEqual(event.fields, { stage: "model_generation", durationMs: 212 });
  assert.doesNotMatch(JSON.stringify(event), /holding company|call me tomorrow|premium package/u);
});

test("event and approved string fields accept labels only, never embedded customer prose", () => {
  const event = buildOperationalEvent("customer asked: tell me about premium", {
    stage: "customer asked for a Cyprus holding company",
    model: "openrouter/gpt-6-luna",
    reasonCode: "safe_policy_fallback"
  });
  assert.equal(event.event, "unknown");
  assert.deepEqual(event.fields, { model: "openrouter/gpt-6-luna", reasonCode: "safe_policy_fallback" });
});
