const OPENROUTER_PRIVACY_POLICY = Object.freeze({
  data_collection: "deny",
  zdr: true
});
const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash";
const DEFAULT_OPENROUTER_FALLBACK_MODEL = "qwen/qwen3.8-27b:free";
const LEGACY_OPENROUTER_MODELS = new Set([
  "inclusionai/ling-3.0-flash-sante:free",
  "openrouter/free"
]);

function withOpenRouterPrivacyPolicy(payload) {
  return {
    ...payload,
    provider: OPENROUTER_PRIVACY_POLICY
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
