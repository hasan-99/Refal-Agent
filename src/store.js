const { redactSensitiveData } = require("./sensitiveData");
const { randomUUID } = require("node:crypto");

class MemoryStore {
  constructor() {
    this.data = { users: {} };
  }

  getUser(userId) {
    return this.data.users[userId] || null;
  }

  deleteUser(userId) {
    if (!this.data.users[userId]) return false;
    delete this.data.users[userId];
    return true;
  }

  deleteConversation(userId) {
    const user = this.data.users[userId];
    if (!user) return { deleted: false, deletedTurns: 0 };
    const deletedTurns = Array.isArray(user.history) ? user.history.length : 0;
    const previousProfile = user.profile || {};
    const safeProfile = {};
    if (previousProfile.followUpBlocked === true) safeProfile.followUpBlocked = true;
    if (previousProfile.qaControlledDiagnostics === true) {
      safeProfile.qaControlledDiagnostics = true;
      if (previousProfile.qaSessionStartedAt) safeProfile.qaSessionStartedAt = previousProfile.qaSessionStartedAt;
      if (previousProfile.qaInitialVerificationStartedAt) safeProfile.qaInitialVerificationStartedAt = previousProfile.qaInitialVerificationStartedAt;
    }
    if (previousProfile.conversationPreferences?.noProactiveBookingOrContact === true) {
      safeProfile.conversationPreferences = { noProactiveBookingOrContact: true };
    }
    user.history = [];
    user.profile = safeProfile;
    user.step = "name";
    user.booking = null;
    if (user.consent && typeof user.consent === "object") {
      const retainedConsent = {};
      for (const scope of ["followUp", "automatedReminder"]) {
        const prior = user.consent[scope];
        if (["denied", "revoked"].includes(prior)) retainedConsent[scope] = prior;
        else if (prior === "granted") retainedConsent[scope] = "revoked";
      }
      if (Object.keys(retainedConsent).length) user.consent = retainedConsent;
      else delete user.consent;
    }
    if (user.followUpState) user.followUpState = { ...user.followUpState, consentState: "revoked", status: "suppressed", nextDueAt: null };
    delete user.leadQualification;
    user.updatedAt = new Date().toISOString();
    return { deleted: true, deletedTurns };
  }

  ensureUser(userId) {
    if (!this.data.users[userId]) {
      const now = new Date().toISOString();
      this.data.users[userId] = {
        id: userId,
        phone: userId.replace(/@.+$/, ""),
        profile: {},
        step: "name",
        history: [],
        createdAt: now,
        updatedAt: now
      };
    }
    return this.data.users[userId];
  }

  updateUser(userId, updater) {
    const user = this.ensureUser(userId);
    updater(user);
    user.updatedAt = new Date().toISOString();
    return user;
  }

  resetUser(userId) {
    const previous = this.data.users[userId];
    const now = new Date().toISOString();
    this.data.users[userId] = {
      id: userId,
      phone: userId.replace(/@.+$/, ""),
      profile: {},
      step: null,
      history: previous?.history || [],
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    this.data.users[userId].history.push({
      at: now,
      message: "reset",
      response: "Your saved details have been cleared."
    });
    return this.data.users[userId];
  }

  addHistory(userId, message, response, extra = {}) {
    let turn;
    this.updateUser(userId, (user) => {
      turn = {
        id: randomUUID(),
        at: extra.at || new Date().toISOString(),
        message: redactSensitiveData(message),
        response: redactSensitiveData(response),
        automated: Boolean(extra.automated),
        source: extra.source || "whatsapp",
        metadata: extra.metadata || {}
      };
      user.history.push(turn);
    });
    return turn;
  }

  claimFollowUpSend(userId, { claimId, consentSourceTurnId, triggerTurnId }) {
    const user = this.getUser(userId);
    if (!user || !claimId || !consentSourceTurnId || !triggerTurnId) return false;
    const existing = user.followUpDelivery || { state: "idle" };
    const freshConsent = (user.history || []).some((turn) => turn.id === consentSourceTurnId
      && turn.metadata?.followUpConsent?.state === "granted"
      && turn.metadata.followUpConsent.purpose === "automated_reminder"
      && turn.metadata.followUpConsent.channel === "whatsapp"
      && turn.metadata.followUpConsent.sourceTurnId === turn.id);
    const freshTrigger = (user.history || []).at(-1)?.id === triggerTurnId;
    const newGrantAfterSend = existing.state === "sent" && existing.consentSourceTurnId !== consentSourceTurnId;
    const consentTurn = (user.history || []).find((turn) => turn.id === consentSourceTurnId);
    const priorDeliveryIsOlder = !user.lastFollowUpSent
      || Date.parse(consentTurn?.at || "") > Date.parse(user.lastFollowUpSent);
    if (!freshConsent || !freshTrigger || !priorDeliveryIsOlder
      || !(["idle", "retryable"].includes(existing.state) || newGrantAfterSend)) return false;
    user.followUpDelivery = { state: "sending", claimId, consentSourceTurnId, triggerTurnId };
    return true;
  }

  finishFollowUpSend(userId, { claimId, outcome, sentAt, providerMessageId, error }) {
    const user = this.getUser(userId);
    const delivery = user?.followUpDelivery;
    if (!delivery || delivery.state !== "sending" || delivery.claimId !== claimId
      || !["sent", "retryable", "uncertain"].includes(outcome)) return false;
    user.followUpDelivery = { ...delivery, state: outcome, error: outcome === "sent" ? null : String(error || "Delivery outcome is ambiguous.").slice(0, 1000), providerMessageId: outcome === "sent" ? String(providerMessageId || "").slice(0, 500) : null };
    if (outcome === "sent") user.lastFollowUpSent = sentAt || new Date().toISOString();
    return true;
  }

  allUsers() {
    return Object.values(this.data.users);
  }

  toJsonData() {
    return this.data;
  }
}

module.exports = { MemoryStore };
