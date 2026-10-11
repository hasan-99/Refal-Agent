const { createHmac } = require("node:crypto");
const ONE_MINUTE_MS = 60 * 1000;

const minuteBuckets = new Map();
const dailyAiBuckets = new Map();
const PRUNE_EVERY_CALLS = 256;
let callsSincePrune = 0;

const AI_LIMIT_MESSAGE =
  "وصلت للحد الأقصى من الأسئلة اليوم، تواصل معنا مباشرة على الإيميل أو الهاتف وفريقنا رح يساعدك ";

function perMinuteLimit() {
  return Number(process.env.RATE_LIMIT_PER_MINUTE || 10);
}

function dailyAiLimit() {
  return Number(process.env.RATE_LIMIT_PER_DAY || 100);
}

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function pruneExpiredBuckets(now, today) {
  const timestamp = now.getTime();
  for (const [userId, bucket] of minuteBuckets) {
    if (timestamp - bucket.windowStart >= ONE_MINUTE_MS) minuteBuckets.delete(userId);
  }
  for (const [userId, bucket] of dailyAiBuckets) {
    if (bucket.day !== today) dailyAiBuckets.delete(userId);
  }
}

function periodicallyPrune(now, today) {
  callsSincePrune += 1;
  if (callsSincePrune < PRUNE_EVERY_CALLS) return;
  callsSincePrune = 0;
  pruneExpiredBuckets(now, today);
}

function allowIncomingMessage(userId, now = new Date()) {
  periodicallyPrune(now, dayKey(now));
  const limit = perMinuteLimit();
  if (!limit || limit < 1) return true;

  const current = minuteBuckets.get(userId);
  if (!current || now.getTime() - current.windowStart >= ONE_MINUTE_MS) {
    minuteBuckets.set(userId, { windowStart: now.getTime(), count: 1 });
    return true;
  }

  current.count += 1;
  return current.count <= limit;
}

function allowAiMessage(userId, now = new Date()) {
  const limit = dailyAiLimit();
  if (!limit || limit < 1) return true;

  const today = dayKey(now);
  periodicallyPrune(now, today);
  const current = dailyAiBuckets.get(userId);
  if (!current || current.day !== today) {
    dailyAiBuckets.set(userId, { day: today, count: 1 });
    return true;
  }

  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function resetRateLimiters() {
  minuteBuckets.clear();
  dailyAiBuckets.clear();
  callsSincePrune = 0;
}

function rateLimitSubjectHash(userId) {
  const secret = process.env.RAFA_API_SECRET;
  if (typeof secret !== "string" || !secret) return null;
  return createHmac("sha256", secret).update(String(userId || ""), "utf8").digest("hex");
}

async function checkSharedLimit({ userId, store, scope, limit, localFallback }) {
  const subjectHash = rateLimitSubjectHash(userId);
  if (!subjectHash || typeof store?.consumeRateLimit !== "function") {
    return { allowed: localFallback(), source: "local" };
  }
  try {
    const result = await store.consumeRateLimit({ scope, subjectHash, limit });
    if (typeof result?.allowed !== "boolean") throw new Error("Invalid shared rate limit response.");
    return { allowed: result.allowed, source: "shared" };
  } catch {
    // Keep a conservative process-local backstop during a temporary database
    // or API outage. Successful production requests use the atomic shared
    // counter, so limits hold across worker instances and restarts.
    return { allowed: localFallback(), source: "local_fallback" };
  }
}

function effectiveLimit(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, 1000) : fallback;
}

async function checkIncomingMessage(userId, { store, now = new Date() } = {}) {
  const limit = effectiveLimit(process.env.RATE_LIMIT_PER_MINUTE, 10);
  if (limit === 0) return { allowed: true, source: "disabled" };
  return checkSharedLimit({ userId, store, scope: "incoming_minute", limit, localFallback: () => allowIncomingMessage(userId, now) });
}

async function checkAiMessage(userId, { store, now = new Date() } = {}) {
  const limit = effectiveLimit(process.env.RATE_LIMIT_PER_DAY, 100);
  if (limit === 0) return { allowed: true, source: "disabled" };
  return checkSharedLimit({ userId, store, scope: "ai_daily", limit, localFallback: () => allowAiMessage(userId, now) });
}

module.exports = {
  AI_LIMIT_MESSAGE,
  allowAiMessage,
  allowIncomingMessage,
  checkAiMessage,
  checkIncomingMessage,
  resetRateLimiters
};
