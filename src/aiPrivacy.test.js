const test = require("node:test");
const assert = require("node:assert/strict");
const { redactPersonalData } = require("./ai");
const { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_FALLBACK_MODEL, resolveOpenRouterModel, withOpenRouterPrivacyPolicy } = require("./openrouterPrivacy");

test("all default chat routes select GPT-6 Luna with compatible private requests", () => {
  assert.equal(DEFAULT_OPENROUTER_MODEL, "openai/gpt-6-luna");
  assert.equal(DEFAULT_OPENROUTER_FALLBACK_MODEL, DEFAULT_OPENROUTER_MODEL);
  for (const old of [undefined, "openrouter/free", "deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-27b:free"]) {
    assert.equal(resolveOpenRouterModel(old), DEFAULT_OPENROUTER_MODEL);
  }
  const request = withOpenRouterPrivacyPolicy({ model: DEFAULT_OPENROUTER_MODEL, temperature: 0.4, top_p: 0.9 });
  assert.equal(request.temperature, undefined);
  assert.equal(request.top_p, undefined);
  assert.deepEqual(request.reasoning, { effort: "none", exclude: true });
  assert.deepEqual(request.provider, { data_collection: "deny", zdr: true });
});

test("model and RAG query sanitizer removes bank and identity secrets while preserving Refalco Group question", () => {
  const input = "Help me set up a company in Cyprus. IBAN: CY17 0020 0128 0000 0012 0052 7600; OTP: 839102; passport number: P1234567";
  const sanitized = redactPersonalData(input);
  assert.match(sanitized, /Help me set up a company in Cyprus/);
  assert.doesNotMatch(sanitized, /CY17|0020 0128|839102|P1234567/);
});
