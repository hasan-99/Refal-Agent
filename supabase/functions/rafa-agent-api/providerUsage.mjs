/**
 * Normalize provider accounting into bounded scalar telemetry fields.
 * @param {Record<string, unknown>} body
 * @param {string} requestedModel
 * @param {number | null} [providerLatencyMs]
 */
export function normalizeOpenRouterUsage(body, requestedModel, providerLatencyMs = null) {
  const usage = body?.usage && typeof body.usage === "object" ? body.usage : {};
  const readInteger = (value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const promptTokens = readInteger(usage.prompt_tokens);
  const completionTokens = readInteger(usage.completion_tokens);
  const totalTokens = readInteger(usage.total_tokens);
  const costUsd = typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
  return {
    model: String(body?.model || requestedModel || "Unknown model").slice(0, 160),
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    providerReported: promptTokens !== null || completionTokens !== null || totalTokens !== null || costUsd !== null,
    providerLatencyMs: Number.isSafeInteger(providerLatencyMs) && providerLatencyMs >= 0 ? providerLatencyMs : null
  };
}
