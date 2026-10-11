const LIMITS = Object.freeze({
  incoming_minute: Object.freeze({ windowSeconds: 60 }),
  ai_daily: Object.freeze({ windowSeconds: 86400 })
});

const HASH = /^[a-f0-9]{64}$/u;

export async function consumeSharedRateLimit(client, input) {
  const scope = input?.scope;
  const contract = LIMITS[scope];
  const subjectHash = String(input?.subjectHash || "");
  const limit = Number(input?.limit);
  if (!contract || !HASH.test(subjectHash) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    const error = new Error("Invalid shared rate limit request.");
    error.statusCode = 400;
    throw error;
  }
  const { data, error } = await client.rpc("rafa_consume_rate_limit", {
    p_scope: scope,
    p_subject_hash: subjectHash,
    p_limit: limit
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== "boolean") throw new Error("Shared rate limit response is invalid.");
  return {
    allowed: row.allowed,
    remaining: Math.max(0, Number(row.remaining) || 0),
    retryAfterSeconds: Math.max(0, Number(row.retry_after_seconds) || 0)
  };
}
