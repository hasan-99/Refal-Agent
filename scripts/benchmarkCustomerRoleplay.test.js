const test = require("node:test");
const assert = require("node:assert/strict");
const { expectedCustomerLanguage, safeSimulatorFailureReason, simulateCustomerTurn } = require("./benchmarkCustomerRoleplay");
const { attributeCustomerTurn, classifyConversationStatus, classifyHardProviderFailure, detectRoleplayLanguageRequest, detectTransliteratedLanguage, safeErrorSummary, summarizeCoverage, updateCustomerLanguage } = require("./runDeepConversationBenchmark");
const { buildDeepConversationCases } = require("./conversationDeepScenarios");

function response(content, usage = {}) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage }) };
}

test("roleplay reacts to the conversation and treats planned concerns as optional when already answered", async () => {
  let request;
  let usage;
  const result = await simulateCustomerTurn({
    locale: "ar", scenario: "company correction", plannedMessage: "The activity is consulting, not retail.",
    persona: "You are cautious and answer briefly.", responseBeat: "If the concern was answered, do not ask it again.", seed: 1803,
    conversation: [{ role: "assistant", content: "What will the company do?" }], apiKey: "test-key",
    model: "customer/model-v2",
    fetchImpl: async (url, options) => { request = { url, ...options, body: JSON.parse(options.body) }; return response("تمام، شكراً. عندي سؤال عن المحاسبة بعد التأسيس.", { prompt_tokens: 100, completion_tokens: 18 }); },
    onUsage: (value) => { usage = value; }
  });
  assert.equal(result.message, "تمام، شكراً. عندي سؤال عن المحاسبة بعد التأسيس.");
  assert.deepEqual(request.body.provider, { data_collection: "deny", zdr: true });
  assert.equal(request.body.model, "customer/model-v2");
  assert.equal(request.body.seed, 1803);
  assert.match(request.body.messages[0].content, /possible concern/u);
  assert.match(request.body.messages[0].content, /not required wording or a mandatory point/u);
  assert.match(request.body.messages[0].content, /do not repeat, paraphrase, or re-ask/u);
  assert.match(request.body.messages[0].content, /cautious and answer briefly/u);
  assert.equal(request.body.messages[1].role, "assistant");
  assert.equal(request.body.messages[2].role, "user");
  assert.deepEqual(usage, { prompt_tokens: 100, completion_tokens: 18 });
  assert.equal(result.seed, 1803);
});

test("roleplay persona tells the customer to correct misunderstandings without forcing every behavior", async () => {
  let payload;
  await simulateCustomerTurn({
    locale: "en", scenario: "company setup", plannedMessage: "I do not want to book a call.",
    persona: "You are impatient and concise.", responseBeat: "If misunderstood, correct the agent; if understood, move on.",
    conversation: [{ role: "assistant", content: "I can explain that here. What activity are you considering?" }], apiKey: "test-key",
    fetchImpl: async (url, options) => { payload = JSON.parse(options.body); return response("I'm considering a small design studio."); }
  });
  assert.match(payload.messages[0].content, /If the agent misunderstood you, correct that naturally/u);
  assert.match(payload.messages[0].content, /Do not insert every behavior mechanically/u);
  assert.match(payload.messages[0].content, /You are impatient and concise/u);
  assert.doesNotMatch(payload.messages[0].content, /MUST remain present/u);
});

test("explicit language switch stays active for response-aware roleplay after the original locale", async () => {
  const conversation = [
    { role: "user", content: "Can you explain company setup in Cyprus?" },
    { role: "assistant", content: "What will the company do?" },
    { role: "user", content: "Actually, can we continue in Greek?" },
    { role: "assistant", content: "Βεβαίως, μπορούμε να συνεχίσουμε στα ελληνικά." },
    { role: "user", content: "Ποια έγγραφα χρειάζονται πρώτα;" },
    { role: "assistant", content: "Τα ακριβή έγγραφα δεν αναφέρονται επιβεβαιωμένα." }
  ];
  assert.equal(updateCustomerLanguage("english", conversation[2].content, true).language, "greek");
  assert.equal(expectedCustomerLanguage("en", conversation), "greek");
  let payload;
  const result = await simulateCustomerTurn({
    locale: "el", scenario: "language_switch", plannedMessage: "Please clarify which documents are needed.",
    conversation, apiKey: "test-key",
    fetchImpl: async (url, options) => { payload = JSON.parse(options.body); return response("Μάλιστα, ευχαριστώ. Θα ήθελα να μάθω και για το κόστος."); }
  });
  assert.equal(result.message, "Μάλιστα, ευχαριστώ. Θα ήθελα να μάθω και για το κόστος.");
  assert.match(payload.messages[0].content, /simple, professional Greek/u);
});

test("D178 Greek request remains active across Greeklish input unless the customer explicitly switches again", () => {
  const item = buildDeepConversationCases(3000).find((scenario) => scenario.id === "D178-greeklish-en");
  assert.ok(item, "expected deterministic D178 Greeklish case");
  const switched = updateCustomerLanguage("english", item.messages[0], true, null, item.scenario);
  assert.equal(switched.language, "greek");
  assert.equal(switched.explicitLanguageLock, "greek");

  const transliterated = updateCustomerLanguage(switched.language, item.messages[1], true, switched.explicitLanguageLock, item.scenario);
  assert.equal(transliterated.language, "greek");
  assert.equal(transliterated.explicitLanguageLock, "greek");

  const switchedBack = updateCustomerLanguage(transliterated.language, "Actually, please continue in English.", true, transliterated.explicitLanguageLock, item.scenario);
  assert.equal(switchedBack.language, "english");
  assert.equal(switchedBack.explicitLanguageLock, "english");
  assert.equal(expectedCustomerLanguage("en", [
    { role: "user", content: item.messages[0] },
    { role: "assistant", content: "Βεβαίως, συνεχίζουμε στα ελληνικά." },
    { role: "user", content: item.messages[1] }
  ]), "greek");
});

test("deep benchmark recognizes hard auth, quota, billing, and rate-limit failures", () => {
  assert.equal(classifyHardProviderFailure("customer-model-http-403"), "http_403");
  assert.equal(classifyHardProviderFailure("model HTTP 429"), "http_429");
  assert.equal(classifyHardProviderFailure("quota exceeded for this account"), "quota_or_billing");
  assert.equal(classifyHardProviderFailure("invalid_api_key"), "authentication");
  assert.equal(classifyHardProviderFailure("customer-model-output-rejected"), null);
});

test("deep benchmark coverage separates partial, degraded, and fully adaptive rows", () => {
  const coverage = summarizeCoverage([
    { locale: "en", runStatus: "fully_adaptive" },
    { locale: "en", runStatus: "degraded" },
    { locale: "en", runStatus: "scripted" },
    { locale: "ar", runStatus: "partial" }
  ], "locale");
  assert.deepEqual(coverage.en, { requested: 3, completed: 3, fullyAdaptive: 1, degraded: 1, scripted: 1, partial: 0 });
  assert.deepEqual(coverage.ar, { requested: 1, completed: 0, fullyAdaptive: 0, degraded: 0, scripted: 0, partial: 1 });
});

test("agent model or retrieval operational errors keep a row out of fully adaptive coverage", () => {
  assert.equal(classifyConversationStatus({ turnCount: 8, expectedTurns: 8, modelEnabled: true, customerFallbacks: 0, operationalErrors: 1 }), "degraded");
  assert.equal(classifyConversationStatus({ turnCount: 8, expectedTurns: 8, modelEnabled: true, customerFallbacks: 0, operationalErrors: 0 }), "fully_adaptive");
});

test("benchmark error summaries redact tokens and provider URLs", () => {
  const safe = safeErrorSummary(new Error("bad sk-or-v1-abcdefghijklmnop https://provider.example/key"));
  assert.doesNotMatch(safe, /abcdefghijklmnop|provider\.example/u);
  assert.match(safe, /\[redacted\]/u);
  assert.match(safe, /\[provider-url\]/u);
});

test("D075 Arabizi is Arabic for the current turn and a later language change can be mirrored", () => {
  const item = buildDeepConversationCases(3000).find((scenario) => scenario.id === "D075-transliteration-en");
  assert.ok(item, "expected deterministic D075 transliteration case");
  const signal = updateCustomerLanguage("english", item.messages[0], true, null, item.scenario);
  assert.equal(signal.language, "arabic");
  assert.equal(signal.explicitLanguageLock, null);

  const romanizedBusinessActivity = updateCustomerLanguage(signal.language, item.messages[1], true, signal.explicitLanguageLock, item.scenario);
  assert.equal(romanizedBusinessActivity.language, "arabic");
  const romanizedPricingQuestion = updateCustomerLanguage(romanizedBusinessActivity.language, item.messages[2], true, romanizedBusinessActivity.explicitLanguageLock, item.scenario);
  assert.equal(romanizedPricingQuestion.language, "arabic");

  const explicitSwitch = updateCustomerLanguage(romanizedPricingQuestion.language, "Please continue in English.", true, romanizedPricingQuestion.explicitLanguageLock, item.scenario);
  assert.equal(explicitSwitch.language, "english");
  assert.equal(explicitSwitch.explicitLanguageLock, "english");

  assert.equal(expectedCustomerLanguage("ar", [
    { role: "user", content: item.messages[0] },
    { role: "assistant", content: "What activity do you have in mind?" },
    { role: "user", content: item.messages[1] },
    { role: "assistant", content: "What is your budget?" },
    { role: "user", content: item.messages[2] }
  ], item.scenario), "arabic");
});

test("Greeklish stays Greek for that turn and a later English customer turn may switch", () => {
  const item = buildDeepConversationCases(3000).find((scenario) => scenario.id === "D025-greeklish-en");
  const initial = updateCustomerLanguage("english", item.messages[0], true, null, item.scenario);
  assert.equal(initial.language, "greek");
  assert.equal(initial.explicitLanguageLock, null);
  const laterEnglish = updateCustomerLanguage(initial.language, "Can you separate published facts from estimates?", true, initial.explicitLanguageLock, item.scenario);
  assert.equal(laterEnglish.language, "english");
});

test("roleplay permits a valid language change in scenarios that allow switching", async () => {
  const result = await simulateCustomerTurn({
    locale: "el", scenario: "greeklish", allowLanguageSwitch: true,
    plannedMessage: "Can you explain that in English?",
    conversation: [{ role: "assistant", content: "Μπορώ να βοηθήσω με την εταιρεία σας." }],
    apiKey: "test-key",
    fetchImpl: async () => response("Could you separate the published details from what needs confirmation?")
  });
  assert.equal(result.message, "Could you separate the published details from what needs confirmation?");
});

test("Arabic transliteration and Greeklish families supply a reliable language signal", () => {
  const cases = buildDeepConversationCases(3000);
  const arabic = cases.find((scenario) => scenario.id === "D126-transliteration-ar");
  const greeklish = cases.find((scenario) => scenario.id === "D025-greeklish-en");
  assert.equal(detectTransliteratedLanguage(arabic.messages[0]), "arabic");
  const arabicTurn = updateCustomerLanguage("english", arabic.messages[0], true, null, arabic.scenario);
  assert.equal(arabicTurn.language, "arabic");
  assert.equal(arabicTurn.explicitLanguageLock, null);
  assert.equal(detectTransliteratedLanguage(greeklish.messages[0]), "greek");
  const greeklishTurn = updateCustomerLanguage("english", greeklish.messages[0], true, null, greeklish.scenario);
  assert.equal(greeklishTurn.language, "greek");
  assert.equal(greeklishTurn.explicitLanguageLock, null);
});

test("Arabic-English mixed conversation recognizes a Syrian Arabic reply request", () => {
  const item = buildDeepConversationCases(3000).find((scenario) => scenario.id === "D023-arabic_english_mix-ar");
  assert.ok(item, "expected deterministic D023 mixed-language case");
  assert.equal(detectRoleplayLanguageRequest(item.messages[2]), "arabic");
  const state = updateCustomerLanguage("english", item.messages[2], true, null, item.scenario);
  assert.equal(state.language, "arabic");
  assert.equal(state.explicitLanguageLock, "arabic");
});

test("fallback attribution is explicit and only records a safe category", () => {
  const turn = { response: "Fallback response" };
  assert.equal(attributeCustomerTurn(turn, "scripted-fallback", "language_mismatch"), turn);
  assert.equal(turn.clientTurnSource, "scripted-fallback");
  assert.equal(turn.clientTurnFallbackReason, "language_mismatch");
  assert.equal(safeSimulatorFailureReason(new Error("customer-model-http-429 private provider detail")), "http_429");
  assert.equal(safeSimulatorFailureReason(new Error("customer-model-language-mismatch")), "language_mismatch");
  assert.equal(safeSimulatorFailureReason(new Error("request failed with authorization Bearer secret")), "provider_error");
  assert.doesNotMatch(JSON.stringify(turn), /Bearer|secret/u);
});

test("roleplay rejects wrong-language output and leaves the caller to use the scripted fallback", async () => {
  await assert.rejects(simulateCustomerTurn({ locale: "el", scenario: "pricing", plannedMessage: "Please clarify the current price.", conversation: [], apiKey: "test-key", fetchImpl: async () => response("Could you confirm the current price?") }), /language-mismatch/);
});

test("roleplay rejects oversized output and redacts credential-like model output", async () => {
  await assert.rejects(simulateCustomerTurn({ locale: "en", scenario: "privacy", plannedMessage: "Do not share credentials.", conversation: [], apiKey: "test-key", fetchImpl: async () => response("x".repeat(481)) }), /output-rejected/);
  const result = await simulateCustomerTurn({ locale: "en", scenario: "privacy", plannedMessage: "Do not share credentials.", conversation: [], apiKey: "test-key", fetchImpl: async () => response("Here is sk-abcdefghijklmnop1234567890") });
  assert.doesNotMatch(result.message, /sk-abcdefghijklmnop1234567890/);
});
