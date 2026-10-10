const cron = require("node-cron");
const { CONSENT_STATES, getConsentState, hasFollowUpPermission } = require("./leadQualification");
const { safeErrorDiagnostics } = require("./operationalTelemetry");

const FOLLOW_UP_MESSAGE = "لسا مهتم تعرف أكتر؟ أنا هون لو عندك أي سؤال ";

function followUpDelayMs() {
  return Number(process.env.FOLLOW_UP_DELAY_HOURS || 24) * 60 * 60 * 1000;
}

function isFollowUpEnabled() {
  return String(process.env.FOLLOW_UP_ENABLED || "true").toLowerCase() !== "false";
}

function isNaturalConversationEnd(text) {
  // REFAL-AGENT-023. The Arabic branch here was unreachable, not merely
  // incomplete: \b is ASCII-only in JavaScript, so `شكرا\b` can never match and
  // Arabic goodbyes were never detected at all. Greek was missing entirely.
  const value = String(text || "");
  return /\b(?:bye|goodbye|thanks|thank you|thx)\b/i.test(value)
    || /(?:شكرا|شكراً|يعطيك العافية|مع السلامة|سلام)/u.test(value)
    || /(?:ευχαριστώ|αντίο|γεια σας|καλή συνέχεια)/iu.test(value);
}

function lastHistoryEntry(user) {
  const history = user.history || [];
  return history[history.length - 1] || null;
}

function followUpTiming(user, now = new Date()) {
  const last = lastHistoryEntry(user);
  const lastMessageAt = last?.at ? new Date(last.at).getTime() : NaN;
  const scheduledAt = user?.followUpState?.status === "scheduled"
    ? new Date(user.followUpState.next_due_at || user.followUpState.nextDueAt).getTime()
    : NaN;
  if (Number.isFinite(scheduledAt)) {
    const delayMs = Number.isFinite(lastMessageAt) ? Math.max(0, scheduledAt - lastMessageAt) : 0;
    const dueAt = new Date(scheduledAt);
    const remainingMs = Math.max(0, scheduledAt - now.getTime());
    return { delayMs, dueAt, remainingMs, due: remainingMs === 0 };
  }
  const delayMs = followUpDelayMs();
  const dueAt = Number.isFinite(lastMessageAt) ? new Date(lastMessageAt + delayMs) : null;
  const remainingMs = dueAt ? Math.max(0, dueAt.getTime() - now.getTime()) : null;
  return { delayMs, dueAt, remainingMs, due: remainingMs === 0 };
}

function followUpReason(user, now = new Date()) {
  if (!user?.id || user.id.startsWith("self-test:")) return "self_test";
  if (user.blocked || user.followUpBlocked) return "blocked";
  const state = getConsentState({ user });
  if ([CONSENT_STATES.DENIED, CONSENT_STATES.REVOKED].includes(state) || user.optedOut === true) return "opted_out";
  if (!hasFollowUpPermission(user)) return "consent_required";
  const last = lastHistoryEntry(user);
  if (!last?.at || !last.response) return "missing_history";
  if (last.automated || last.message === "[auto-follow-up]") return "automated_message";
  if (isNaturalConversationEnd(last.message)) return "natural_end";
  if (!followUpTiming(user, now).due) return "not_due";
  if (user.lastFollowUpSent && new Date(user.lastFollowUpSent).getTime() >= new Date(last.at).getTime()) return "already_sent";
  return "ready";
}

function shouldSendFollowUp(user, now = new Date()) {
  if (!user?.id || user.id.startsWith("self-test:") || user.blocked || user.followUpBlocked) return false;
  if (!hasFollowUpPermission(user)) return false;
  const last = lastHistoryEntry(user);
  if (!last?.at || !last.response || last.automated || last.message === "[auto-follow-up]" || isNaturalConversationEnd(last.message)) return false;
  const lastMessageAt = new Date(last.at).getTime();
  if (!Number.isFinite(lastMessageAt) || !followUpTiming(user, now).due) return false;
  const lastFollowUpSent = user.lastFollowUpSent ? new Date(user.lastFollowUpSent).getTime() : 0;
  return !lastFollowUpSent || lastFollowUpSent < lastMessageAt;
}

function getFollowUpDecision(user, now = new Date()) {
  const reason = followUpReason(user, now);
  return { allowed: reason === "ready", eligible: reason === "ready", reason, consent: getConsentState({ user }), timing: followUpTiming(user, now) };
}

async function runFollowUpCheck({ store, sendFollowUp, now = new Date(), logEvent = () => {} }) {
  if (!isFollowUpEnabled()) return { sent: 0 };
  let sent = 0;
  const users = store.allUsers ? await store.allUsers({ includeHistory: true }) : Object.values(store.data.users || {});
  for (const user of users) {
    if (!shouldSendFollowUp(user, now)) continue;
    if (typeof store.isContactBlocked === "function" && await store.isContactBlocked(user.id)) continue;
    await sendFollowUp(user.id, FOLLOW_UP_MESSAGE);
    const sentAt = now.toISOString();
    await store.updateUser(user.id, (draft) => { draft.lastFollowUpSent = sentAt; });
    await store.addHistory(user.id, "[auto-follow-up]", FOLLOW_UP_MESSAGE, { at: sentAt, automated: true });
    if (typeof store.saveFollowUpState === "function") {
      await store.saveFollowUpState(user.id, { consentState: CONSENT_STATES.GRANTED, status: "sent", lastSentAt: sentAt, nextDueAt: null });
    }
    sent += 1;
    logEvent("follow_up_sent", { userId: user.id, sentAt });
  }
  return { sent };
}

function startFollowUpSchedule({ store, sendFollowUp, logEvent }) {
  const schedule = process.env.FOLLOW_UP_CRON || "0 * * * *";
  const timezone = process.env.FOLLOW_UP_TIMEZONE || "Europe/Nicosia";
  return cron.schedule(schedule, async () => {
    try {
      const result = await runFollowUpCheck({ store, sendFollowUp, logEvent });
      logEvent("follow_up_check", { sent: result.sent });
    } catch (error) {
      console.error("Follow-up check failed:", safeErrorDiagnostics(error));
      logEvent("follow_up_error", safeErrorDiagnostics(error));
    }
  }, { timezone });
}

module.exports = { CONSENT_STATES, FOLLOW_UP_MESSAGE, followUpReason, followUpTiming, getConsentState, getFollowUpDecision, hasFollowUpPermission, isNaturalConversationEnd, runFollowUpCheck, shouldSendFollowUp, startFollowUpSchedule };
