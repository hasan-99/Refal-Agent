const cron = require("node-cron");
const { randomUUID } = require("node:crypto");
const { CONSENT_STATES, getConsentState, getAutomatedReminderConsent, hasFollowUpPermission, hasAutomatedReminderPermission } = require("./leadQualification");
const { safeErrorDiagnostics } = require("./operationalTelemetry");

const FOLLOW_UP_MESSAGE = "لسا مهتم تعرف أكتر؟ أنا هون لو عندك أي سؤال ";
const activeFollowUpStores = new WeakSet();

function followUpMessage(language) {
  const normalized = String(language || "").trim().toLowerCase();
  if (["el", "greek"].includes(normalized)) return "Σας ενδιαφέρει να μάθετε περισσότερα; Είμαι εδώ αν έχετε κάποια ερώτηση.";
  if (["ar", "arabic"].includes(normalized)) return FOLLOW_UP_MESSAGE;
  return "Would you like to know more? I’m here if you have any questions.";
}

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
  const configuredDelayMs = followUpDelayMs();
  const minimumSilenceMs = Math.max(24 * 60 * 60 * 1000, Number.isFinite(configuredDelayMs) ? configuredDelayMs : 0);
  const scheduledAt = user?.followUpState?.status === "scheduled"
    ? new Date(user.followUpState.next_due_at || user.followUpState.nextDueAt).getTime()
    : NaN;
  if (Number.isFinite(scheduledAt)) {
    const earliestAt = Number.isFinite(lastMessageAt) ? lastMessageAt + minimumSilenceMs : scheduledAt;
    const dueTimestamp = Math.max(scheduledAt, earliestAt);
    const delayMs = Number.isFinite(lastMessageAt) ? Math.max(0, dueTimestamp - lastMessageAt) : 0;
    const dueAt = new Date(dueTimestamp);
    const remainingMs = Math.max(0, dueTimestamp - now.getTime());
    return { delayMs, dueAt, remainingMs, due: remainingMs === 0 };
  }
  const delayMs = minimumSilenceMs;
  const dueAt = Number.isFinite(lastMessageAt) ? new Date(lastMessageAt + delayMs) : null;
  const remainingMs = dueAt ? Math.max(0, dueAt.getTime() - now.getTime()) : null;
  return { delayMs, dueAt, remainingMs, due: remainingMs === 0 };
}

function followUpReason(user, now = new Date()) {
  if (!user?.id || user.id.startsWith("self-test:")) return "self_test";
  if (user.blocked || user.followUpBlocked) return "blocked";
  const state = getConsentState({ user });
  if ([CONSENT_STATES.DENIED, CONSENT_STATES.REVOKED].includes(state) || user.optedOut === true) return "opted_out";
  const reminderConsent = getAutomatedReminderConsent(user, now);
  if (!reminderConsent) return "consent_required";
  if (String(reminderConsent.channel || "").trim().toLowerCase() !== "whatsapp") return "consent_channel_mismatch";
  const last = lastHistoryEntry(user);
  const delivery = user.followUpState || user.followUpDelivery;
  if (delivery?.delivery_state === "sending" || delivery?.state === "sending" || delivery?.status === "sending") return "delivery_in_progress";
  if (delivery?.delivery_state === "uncertain" || delivery?.state === "uncertain" || delivery?.status === "uncertain") return "delivery_uncertain";
  if (!last?.at || !last.response) return "missing_history";
  if (last.source === "auto-follow-up" || last.message === "[auto-follow-up]") return "automated_message";
  if (isNaturalConversationEnd(last.message)) return "natural_end";
  if (!followUpTiming(user, now).due) return "not_due";
  if (user.lastFollowUpSent && new Date(user.lastFollowUpSent).getTime() >= new Date(last.at).getTime()) return "already_sent";
  return "ready";
}

function shouldSendFollowUp(user, now = new Date()) {
  if (!user?.id || user.id.startsWith("self-test:") || user.blocked || user.followUpBlocked) return false;
  const reminderConsent = getAutomatedReminderConsent(user, now);
  if (!reminderConsent || String(reminderConsent.channel || "").trim().toLowerCase() !== "whatsapp") return false;
  const delivery = user.followUpState || user.followUpDelivery;
  if (["sending", "uncertain"].includes(String(delivery?.delivery_state || delivery?.state || delivery?.status || ""))) return false;
  const last = lastHistoryEntry(user);
  if (!last?.at || !last.response || last.source === "auto-follow-up" || last.message === "[auto-follow-up]" || isNaturalConversationEnd(last.message)) return false;
  const lastMessageAt = new Date(last.at).getTime();
  if (!Number.isFinite(lastMessageAt) || !followUpTiming(user, now).due) return false;
  const lastFollowUpSent = user.lastFollowUpSent ? new Date(user.lastFollowUpSent).getTime() : 0;
  return !lastFollowUpSent || lastFollowUpSent < lastMessageAt;
}

function getFollowUpDecision(user, now = new Date()) {
  const reason = followUpReason(user, now);
  const consent = hasAutomatedReminderPermission(user) ? CONSENT_STATES.GRANTED : getConsentState({ user });
  return { allowed: reason === "ready", eligible: reason === "ready", reason, consent, timing: followUpTiming(user, now) };
}

async function runFollowUpCheck({ store, sendFollowUp, now = new Date(), logEvent = () => {} }) {
  if (!isFollowUpEnabled()) return { sent: 0 };
  if (!store || typeof store !== "object") throw new Error("Follow-up store is unavailable.");
  if (activeFollowUpStores.has(store)) return { sent: 0, skipped: true, reason: "check_in_progress" };
  activeFollowUpStores.add(store);
  try {
    const users = store.allUsers ? await store.allUsers({ includeHistory: true }) : Object.values(store.data.users || {});
    const eligible = users.filter((user) => shouldSendFollowUp(user, now));
    if (eligible.length && typeof store.isContactBlocked !== "function") {
      logEvent("follow_up_suppression_check_unavailable", { eligibleCount: eligible.length });
      return { sent: 0, disabled: true, reason: "suppression_check_unavailable" };
    }
    if (eligible.length && typeof store.getUser !== "function") {
      logEvent("follow_up_consent_check_unavailable", { eligibleCount: eligible.length });
      return { sent: 0, disabled: true, reason: "consent_check_unavailable" };
    }
    if (eligible.length && (typeof store.claimFollowUpSend !== "function" || typeof store.finishFollowUpSend !== "function")) {
      logEvent("follow_up_delivery_claim_unavailable", { eligibleCount: eligible.length });
      return { sent: 0, disabled: true, reason: "delivery_claim_unavailable" };
    }
    // Complete every suppression lookup before any outbound send. If one lookup
    // fails, the promise rejects and the caller's scheduler error path sends none.
    const blockedStates = await Promise.all(eligible.map((user) => store.isContactBlocked(user.id)));
    let sent = 0;
    let deliveryStateUnconfirmed = 0;
    for (const [index, user] of eligible.entries()) {
      if (blockedStates[index]) continue;
      if (await store.isContactBlocked(user.id)) continue;
      // Bulk eligibility is only a candidate snapshot. Consent and the latest
      // customer turn must be reread immediately before each outbound send.
      const currentUser = await store.getUser(user.id);
      if (!currentUser || !shouldSendFollowUp(currentUser, now)) continue;
      const consent = getAutomatedReminderConsent(currentUser, now);
      // The scheduler sends through WhatsApp; a grant for email or another
      // channel must never authorize this delivery.
      if (!consent || String(consent.channel || "").trim().toLowerCase() !== "whatsapp") continue;
      const message = followUpMessage(consent.language);
      const sentAt = now.toISOString();
      const last = lastHistoryEntry(currentUser);
      if (!last?.id || !consent.sourceTurnId) continue;
      const claimId = randomUUID();
      const claimed = await store.claimFollowUpSend(user.id, {
        claimId,
        consentSourceTurnId: consent.sourceTurnId,
        triggerTurnId: last.id
      });
      if (!claimed) continue;
      let delivery;
      try {
        delivery = await sendFollowUp(user.id, message);
      } catch (error) {
        const retryable = error?.definitelyNotSent === true || error?.deliveryOutcome === "not_sent";
        const outcome = retryable ? "retryable" : "uncertain";
        try {
          const finished = await store.finishFollowUpSend(user.id, {
            claimId,
            triggerTurnId: last.id,
            outcome,
            finishedAt: sentAt,
            error: outcome === "retryable" ? "provider_confirmed_not_sent" : "provider_outcome_ambiguous"
          });
          if (finished !== true) {
            deliveryStateUnconfirmed += 1;
            try { logEvent("follow_up_delivery_state_unconfirmed", { outcome }); } catch { /* State remains non-reclaimable even if telemetry is unavailable. */ }
          }
        } catch {
          // `sending` is a permanent no-reclaim state, so failure to record an
          // ambiguous result cannot turn into an automatic duplicate send.
          deliveryStateUnconfirmed += 1;
          try { logEvent("follow_up_delivery_state_unconfirmed", { outcome }); } catch { /* Preserve the send outcome if telemetry is unavailable. */ }
        }
        logEvent("follow_up_delivery_error", { userId: user.id, outcome });
        continue;
      }
      let finished = false;
      try {
        finished = await store.finishFollowUpSend(user.id, {
          claimId,
          triggerTurnId: last.id,
          outcome: "sent",
          finishedAt: sentAt,
          providerMessageId: delivery?.key?.id || ""
        }) === true;
      } catch {
        // The durable claim remains `sending`, which is deliberately not
        // reclaimable after a provider accepted the message.
      }
      if (!finished) {
        deliveryStateUnconfirmed += 1;
        try { logEvent("follow_up_delivery_state_unconfirmed", { outcome: "sent" }); } catch { /* The provider accepted the message; telemetry is best effort. */ }
      }
      if (typeof store.updateUser === "function") await store.updateUser(user.id, (draft) => { draft.lastFollowUpSent = sentAt; });
      if (typeof store.addHistory === "function") await store.addHistory(user.id, "[auto-follow-up]", message, { at: sentAt, automated: true, source: "auto-follow-up" });
      sent += 1;
      logEvent("follow_up_sent", { userId: user.id, sentAt });
    }
    return deliveryStateUnconfirmed ? { sent, deliveryStateUnconfirmed } : { sent };
  } finally {
    activeFollowUpStores.delete(store);
  }
}

function startFollowUpSchedule({ store, sendFollowUp, logEvent }) {
  const schedule = process.env.FOLLOW_UP_CRON || "0 * * * *";
  const timezone = process.env.FOLLOW_UP_TIMEZONE || "Europe/Nicosia";
  return cron.schedule(schedule, async () => {
    try {
      const result = await runFollowUpCheck({ store, sendFollowUp, logEvent });
      logEvent("follow_up_check", { sent: result.sent, deliveryStateUnconfirmed: result.deliveryStateUnconfirmed || 0 });
    } catch (error) {
      console.error("Follow-up check failed:", safeErrorDiagnostics(error));
      logEvent("follow_up_error", safeErrorDiagnostics(error));
    }
  }, { timezone });
}

module.exports = { CONSENT_STATES, FOLLOW_UP_MESSAGE, followUpMessage, followUpReason, followUpTiming, getConsentState, getFollowUpDecision, hasFollowUpPermission, isNaturalConversationEnd, runFollowUpCheck, shouldSendFollowUp, startFollowUpSchedule };
