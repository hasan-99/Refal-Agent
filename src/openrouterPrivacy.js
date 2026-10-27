const OPENROUTER_PRIVACY_POLICY = Object.freeze({
  data_collection: "deny",
  zdr: true
});
// Primary: Claude Sonnet 5.5. Fallback: GPT-6 Luna, the previous default, from a
// different provider so one provider outage does not stop replies. Both have
// zero-data-retention endpoints on OpenRouter (verified 2026-10-28).
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-5.5";
const DEFAULT_OPENROUTER_FALLBACK_MODEL = "openai/gpt-6-luna";
// Their ZDR endpoints accept no sampling parameters, so temperature/top_p are
// dropped and reasoning is switched off explicitly for both.
const NO_SAMPLING_PARAMETER_MODELS = new Set([DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_FALLBACK_MODEL]);
const LEGACY_OPENROUTER_MODELS = new Set([
  "inclusionai/ling-3.0-flash-sante:free",
  "openrouter/free",
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3.8-27b:free"
]);

function withOpenRouterPrivacyPolicy(payload) {
  const compatible = { ...payload };
  if (NO_SAMPLING_PARAMETER_MODELS.has(compatible.model)) {
    delete compatible.temperature;
    delete compatible.top_p;
    compatible.reasoning = { effort: "none", exclude: true };
  }
  // One Anthropic ZDR endpoint (Amazon Bedrock) lacks strict structured
  // outputs. A json_schema request must only route to endpoints that honour
  // every parameter, or a decision could come back as unconstrained text.
  const strictJson = String(compatible.model || "").startsWith("anthropic/") && compatible.response_format?.type === "json_schema";
  return {
    ...compatible,
    provider: strictJson ? { ...OPENROUTER_PRIVACY_POLICY, require_parameters: true } : OPENROUTER_PRIVACY_POLICY
  };
}

function resolveOpenRouterModel(value, fallback = DEFAULT_OPENROUTER_MODEL) {
  const model = String(value || "").trim();
  return !model || LEGACY_OPENROUTER_MODELS.has(model) ? fallback : model;
}

function classifyEmbeddingFailure(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (/no endpoints found matching your data policy.*zero data retention/.test(message)) return "no eligible zero-data-retention embedding endpoint";
  if (/free-models-per-day|rate limit|quota/.test(message)) return "quota or rate limit";
  if (/401|unauthorized|invalid api key/.test(message)) return "authentication rejected";
  if (/402|insufficient credits|payment required/.test(message)) return "provider credits required";
  return "provider error";
}

module.exports = {
  classifyEmbeddingFailure,
  DEFAULT_OPENROUTER_FALLBACK_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  LEGACY_OPENROUTER_MODELS,
  OPENROUTER_PRIVACY_POLICY,
  resolveOpenRouterModel,
  withOpenRouterPrivacyPolicy
};
