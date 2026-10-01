const cron = require("node-cron");
const { CONSENT_STATES, hasFollowUpPermission } = require("./leadQualification");

const FOLLOW_UP_MESSAGE = "لسا مهتم تعرف أكتر؟ أنا هون لو عندك أي سؤال ";

function followUpDelayMs() {
  return Number(process.env.FOLLOW_UP_DELAY_HOURS || 24) * 60 * 60 * 1000;
}

function isFollowUpEnabled() {
  return String(process.env.FOLLOW_UP_ENABLED || "true").toLowerCase() !== "false";
}

function isNaturalConversationEnd(text) {
  return /\b(bye|goodbye|thanks|thank you|thx|شكرا|شكراً|يعطيك العافية|مع السلامة|سلام)\b/i.test(String(text || ""));
}

function lastHistoryEntry(user) {
  const history = user.history || [];
  return history[history.length - 1] || null;
}

function shouldSendFollowUp(user, now = new Date()) {
  if (!user?.id || user.id.startsWith("self-test:")) return false;
  const last = lastHistoryEntry(user);
  if ([CONSENT_STATES.DENIED, CONSENT_STATES.REVOKED].includes(user.consent?.followUp) || [CONSENT_STATES.DENIED, CONSENT_STATES.REVOKED].includes(user.followUpConsent) || user.optedOut === true) return false;
  const consentAware = user.consent?.followUp !== undefined || user.followUpConsent !== undefined || user.optedOut !== undefined;
  if (consentAware && !hasFollowUpPermission(user)) return false;
  if (!last?.at || !last.response || last.automated || last.message === "[auto-follow-up]" || isNaturalConversationEnd(last.message)) return false;
  const lastMessageAt = new Date(last.at).getTime();
  if (!Number.isFinite(lastMessageAt) || now.getTime() - lastMessageAt < followUpDelayMs()) return false;
  const lastFollowUpSent = user.lastFollowUpSent ? new Date(user.lastFollowUpSent).getTime() : 0;
  return !lastFollowUpSent || lastFollowUpSent < lastMessageAt;
}

function getFollowUpDecision(user, now = new Date()) {
  const allowed = shouldSendFollowUp(user, now);
  const state = user?.consent?.followUp ?? user?.followUpConsent ?? CONSENT_STATES.UNKNOWN;
  let reason = "eligible";
  if ([CONSENT_STATES.DENIED, CONSENT_STATES.REVOKED].includes(state) || user?.optedOut === true) reason = "consent_denied";
  else if (state !== CONSENT_STATES.GRANTED && user?.consent?.followUp !== undefined) reason = "consent_required";
  else if (!allowed) reason = "conversation_not_eligible";
  const lastAt = lastHistoryEntry(user)?.at ? new Date(lastHistoryEntry(user).at).getTime() : NaN;
  return { allowed, reason, consent: state, delayMs: followUpDelayMs(), dueAt: Number.isFinite(lastAt) ? new Date(lastAt + followUpDelayMs()).toISOString() : null };
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
      console.error("Follow-up check failed:", error.message);
      logEvent("follow_up_error", { message: error.message });
    }
  }, { timezone });
}

module.exports = { FOLLOW_UP_MESSAGE, getFollowUpDecision, isNaturalConversationEnd, runFollowUpCheck, shouldSendFollowUp, startFollowUpSchedule };
