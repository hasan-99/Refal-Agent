export function buildModelUsageEvent(source, userId, usage = {}) {
  return {
    event: usage.providerReported ? "ai_usage" : "ai_usage_missing",
    fields: {
      source,
      userId,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd,
      providerLatencyMs: usage.providerLatencyMs
    }
  };
}
