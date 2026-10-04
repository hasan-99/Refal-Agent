const ONE_MINUTE_MS = 60 * 1000;

const minuteBuckets = new Map();
const dailyAiBuckets = new Map();

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

function allowIncomingMessage(userId, now = new Date()) {
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
}

module.exports = {
  AI_LIMIT_MESSAGE,
  allowAiMessage,
  allowIncomingMessage,
  resetRateLimiters
};
