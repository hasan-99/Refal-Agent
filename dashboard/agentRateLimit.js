export function createAgentRateLimit({ limit = 30, windowMs = 10 * 60 * 1000, now = Date.now, maxEntries = 5000 } = {}) {
  const buckets = new Map();
  return function limitAgentChat(req, res, next) {
    const timestamp = now();
    const key = String(req.dashboardUser?.id || req.ip || "unknown");
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= timestamp) {
      entry = { count: 0, resetAt: timestamp + windowMs };
      buckets.set(key, entry);
    }
    if (buckets.size > maxEntries) {
      for (const [bucket, value] of buckets) if (value.resetAt <= timestamp) buckets.delete(bucket);
      while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
    }
    if (entry.count >= limit) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000)));
      return res.status(429).json({ error: "Too many assistant requests. Wait a few minutes and try again." });
    }
    entry.count += 1;
    return next();
  };
}
