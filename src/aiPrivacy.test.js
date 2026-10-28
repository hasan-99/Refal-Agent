const test = require("node:test");
const assert = require("node:assert/strict");
const { redactPersonalData } = require("./ai");
const { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_FALLBACK_MODEL, resolveOpenRouterModel, withOpenRouterPrivacyPolicy } = require("./openrouterPrivacy");

test("default chat routes select Claude Sonnet 5.5 with a GPT-6 Luna fallback and compatible private requests", () => {
  assert.equal(DEFAULT_OPENROUTER_MODEL, "anthropic/claude-sonnet-5.5");
  assert.equal(DEFAULT_OPENROUTER_FALLBACK_MODEL, "openai/gpt-6-luna");
  for (const old of [undefined, "openrouter/free", "deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-27b:free"]) {
    assert.equal(resolveOpenRouterModel(old), DEFAULT_OPENROUTER_MODEL);
  }
  for (const model of [DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_FALLBACK_MODEL]) {
    const request = withOpenRouterPrivacyPolicy({ model, temperature: 0.4, top_p: 0.9 });
    assert.equal(request.temperature, undefined);
    assert.equal(request.top_p, undefined);
    assert.deepEqual(request.reasoning, { effort: "low", exclude: true });
    assert.deepEqual(request.provider, { data_collection: "deny", zdr: true });
  }
});

test("strict-JSON Anthropic requests only route to endpoints that honour every parameter", () => {
  const schema = { type: "json_schema", json_schema: { name: "x", strict: true, schema: { type: "object" } } };
  assert.deepEqual(withOpenRouterPrivacyPolicy({ model: DEFAULT_OPENROUTER_MODEL, response_format: schema }).provider,
    { data_collection: "deny", zdr: true, require_parameters: true });
  assert.deepEqual(withOpenRouterPrivacyPolicy({ model: DEFAULT_OPENROUTER_FALLBACK_MODEL, response_format: schema }).provider,
    { data_collection: "deny", zdr: true });
  assert.deepEqual(withOpenRouterPrivacyPolicy({ model: DEFAULT_OPENROUTER_MODEL }).provider, { data_collection: "deny", zdr: true });
});

test("model and RAG query sanitizer removes bank and identity secrets while preserving Refalco Group question", () => {
  const input = "Help me set up a company in Cyprus. IBAN: CY17 0020 0128 0000 0012 0052 7600; OTP: 839102; passport number: P1234567";
  const sanitized = redactPersonalData(input);
  assert.match(sanitized, /Help me set up a company in Cyprus/);
  assert.doesNotMatch(sanitized, /CY17|0020 0128|839102|P1234567/);
});

test("personal-data redaction removes self-identified names without erasing business-interest boundaries", () => {
  const input = "I am not interested in investment or property. I am Hasan Ahmed. I only want company formation.";
  const sanitized = redactPersonalData(input);
  assert.match(sanitized, /I am not interested in investment or property/);
  assert.match(sanitized, /I only want company formation/);
  assert.doesNotMatch(sanitized, /Hasan/);

  const explicitName = redactPersonalData("My name is Hasan and I do not want property services.");
  assert.doesNotMatch(explicitName, /Hasan/);
  assert.match(explicitName, /I do not want property services/);
});
