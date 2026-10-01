function requireRafaApiConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const apiSecret = process.env.RAFA_API_SECRET;
  if (!url || !key || !apiSecret) {
    throw new Error("Missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or RAFA_API_SECRET in .env.");
  }
  return {
    apiUrl: process.env.RAFA_API_URL || `${url.replace(/\/$/, "")}/functions/v1/rafa-agent-api`,
    key,
    apiSecret
  };
}

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `RAFA API request failed: ${response.status}`);
  }
  return body;
}

class EdgeApiStore {
  constructor(config = requireRafaApiConfig()) {
    this.apiUrl = config.apiUrl;
    this.key = config.key;
    this.apiSecret = config.apiSecret;
    this.data = { users: {} };
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      ...options,
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        "x-rafa-api-secret": this.apiSecret,
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    return parseResponse(response);
  }

  async hydrate() {
    const { users } = await this.request("/contacts");
    this.data = { users: Object.fromEntries((users || []).map((user) => [user.id, user])) };
    return this.data;
  }

  async allUsers({ includeHistory = false } = {}) {
    const { users } = await this.request(`/contacts?includeHistory=${includeHistory ? "true" : "false"}`);
    this.data = { users: Object.fromEntries((users || []).map((user) => [user.id, user])) };
    return users || [];
  }

  async toJsonData({ includeHistory = true } = {}) {
    const users = await this.allUsers({ includeHistory });
    return { users: Object.fromEntries(users.map((user) => [user.id, user])) };
  }

  async getUser(userId, { includeHistory = true } = {}) {
    const { user } = await this.request(`/contacts/${encodeURIComponent(userId)}?includeHistory=${includeHistory ? "true" : "false"}`);
    if (user) this.data.users[userId] = user;
    return user || null;
  }

  async deleteUser(userId) {
    const { deleted } = await this.request(`/contacts/${encodeURIComponent(userId)}`, { method: "DELETE" });
    delete this.data.users[userId];
    return Boolean(deleted);
  }

  async ensureUser(userId) {
    const { user } = await this.request("/contacts/ensure", {
      method: "POST",
      body: JSON.stringify({ userId })
    });
    this.data.users[userId] = user;
    return user;
  }

  async updateUser(userId, updater) {
    const user = await this.ensureUser(userId);
    await updater(user);
    const { user: updated } = await this.request(`/contacts/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({
        phone: user.phone,
        profile: user.profile || {},
        step: user.step || null,
        whatsapp: user.whatsapp || {},
        booking: user.booking || null,
        lastFollowUpSent: user.lastFollowUpSent || null
      })
    });
    this.data.users[userId] = updated;
    return updated;
  }

  async resetUser(userId) {
    const user = await this.ensureUser(userId);
    const { user: reset } = await this.request(`/contacts/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({
        phone: String(userId || "").replace(/@.+$/, ""),
        profile: {},
        step: null,
        whatsapp: user.whatsapp || {},
        booking: null,
        lastFollowUpSent: null
      })
    });
    this.data.users[userId] = reset;
    await this.addHistory(userId, "reset", "Profile reset");
    return this.getUser(userId);
  }

  async addHistory(userId, message, response, extra = {}) {
    const { turn, user } = await this.request(`/contacts/${encodeURIComponent(userId)}/history`, {
      method: "POST",
      body: JSON.stringify({
        message,
        response,
        automated: Boolean(extra.automated),
        source: extra.source || "whatsapp",
        metadata: extra.metadata || {},
        at: extra.at
      })
    });
    const current = user || (await this.ensureUser(userId));
    current.history = [...(current.history || []), turn];
    this.data.users[userId] = current;
    return turn;
  }

  async updateHistoryTurn(userId, turnId, patch) {
    const { turn } = await this.request(
      `/contacts/${encodeURIComponent(userId)}/history/${encodeURIComponent(turnId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch)
      }
    );
    const current = this.data.users[userId];
    if (current?.history) {
      current.history = current.history.map((item) => item.id === turnId ? turn : item);
    }
    return turn;
  }

  async logEvent(event, fields = {}) {
    await this.request("/events", {
      method: "POST",
      body: JSON.stringify({ event, fields })
    });
  }

  async persistWorkflow(kind, payload) {
    return this.request(`/workflows/${encodeURIComponent(kind)}`, {
      method: "POST",
      body: JSON.stringify(payload || {})
    });
  }

  async saveQualification(userId, dimensions, options = {}) {
    const { qualification } = await this.persistWorkflow("qualification", {
      userId,
      dimensions,
      sourceTurnId: options.sourceTurnId,
      thresholds: options.thresholds,
      priority: options.priority,
      priorityReason: options.priorityReason
    });
    return qualification;
  }

  async saveIntents(userId, intents, options = {}) {
    const { intents: saved } = await this.persistWorkflow("intents", { userId, intents, sourceTurnId: options.sourceTurnId, confidence: options.confidence, source: options.source });
    return saved || [];
  }

  async saveConsent(userId, state, options = {}) {
    const { consent } = await this.persistWorkflow("consent", { userId, consentType: "follow_up", state, ...options });
    return consent;
  }

  async saveFollowUpState(userId, state) {
    const { followUp } = await this.persistWorkflow("follow-up", { userId, ...state });
    return followUp;
  }

  async createHandover(userId, handover) {
    const { handover: saved } = await this.persistWorkflow("handover", { userId, ...handover });
    return saved;
  }

  async createPriorityAlert(userId, alert) {
    const { alert: saved } = await this.persistWorkflow("priority-alert", { userId, ...alert });
    return saved;
  }

  async createComplaint(userId, complaint) {
    const { complaint: saved } = await this.persistWorkflow("complaint", { userId, ...complaint });
    return saved;
  }

  async saveExistingClientVerification(userId, state) {
    const { verification } = await this.persistWorkflow("existing-client-verification", { userId, ...state });
    return verification;
  }

  async logAuditEvent(userId, event, details = {}, actorType = "system") {
    const { auditEvent } = await this.persistWorkflow("audit-event", { userId, event, details, actorType });
    return auditEvent;
  }

  async searchKnowledge(query, embedding = null, embeddingModel = null, matchCount = 6) {
    const { results } = await this.request("/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ query: String(query || "").slice(0, 1000), embedding, embeddingModel, matchCount })
    });
    return results || [];
  }

  async getBookingPolicy() {
    const { policy } = await this.request("/settings/booking-policy");
    return policy || null;
  }

  async updateBookingPolicy(policy) {
    const { policy: saved } = await this.request("/settings/booking-policy", {
      method: "PUT",
      body: JSON.stringify({ policy })
    });
    return saved;
  }

  async createAppointment(appointment) {
    return this.request("/appointments", {
      method: "POST",
      body: JSON.stringify(appointment)
    });
  }

  async updateAppointment(appointmentId, patch) {
    const { appointment } = await this.request(`/appointments/${encodeURIComponent(appointmentId)}`, {
      method: "PUT",
      body: JSON.stringify(patch)
    });
    return appointment;
  }

  async createReminder(appointmentId, reminder) {
    return this.request(`/appointments/${encodeURIComponent(appointmentId)}/reminders`, {
      method: "POST",
      body: JSON.stringify(reminder)
    });
  }

  async getAppointment(appointmentId) {
    const { appointment } = await this.request(`/appointments/${encodeURIComponent(appointmentId)}`);
    return appointment || null;
  }

  async claimDueReminders(limit = 25) {
    const { reminders } = await this.request("/reminders/claim", {
      method: "POST",
      body: JSON.stringify({ limit })
    });
    return reminders || [];
  }

  async updateReminder(reminderId, patch) {
    const { reminder } = await this.request(`/reminders/${encodeURIComponent(reminderId)}`, {
      method: "PUT",
      body: JSON.stringify(patch)
    });
    return reminder;
  }

  async createNotification(notification) {
    return this.request("/notifications", { method: "POST", body: JSON.stringify(notification) });
  }

  async claimDueNotifications(limit = 25) {
    const { notifications } = await this.request("/notifications/claim", { method: "POST", body: JSON.stringify({ limit }) });
    return notifications || [];
  }

  async updateNotification(notificationId, patch) {
    const { notification } = await this.request(`/notifications/${encodeURIComponent(notificationId)}`, { method: "PUT", body: JSON.stringify(patch) });
    return notification;
  }

  async listNotifications({ status = "" } = {}) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const { notifications } = await this.request(`/notifications${query}`);
    return notifications || [];
  }

  async retryNotification(notificationId) {
    const { notification } = await this.request(`/notifications/${encodeURIComponent(notificationId)}/retry`, { method: "POST", body: JSON.stringify({}) });
    return notification;
  }

  async listAppointments({ limit = 200, status = "" } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set("status", status);
    const { appointments } = await this.request(`/appointments?${params}`);
    return appointments || [];
  }

  async isContactBlocked(userId) {
    const { blocked } = await this.request(`/blocks/check?userId=${encodeURIComponent(userId)}`);
    return Boolean(blocked);
  }

  async claimInboundMessage(userId, messageId) {
    return this.request("/messages/claim", { method: "POST", body: JSON.stringify({ userId, messageId }) });
  }

  async completeInboundMessage(userId, messageId) {
    return this.request("/messages/complete", { method: "POST", body: JSON.stringify({ userId, messageId }) });
  }

  async listContactBlocks() {
    const { blocks } = await this.request("/blocks");
    return blocks || [];
  }

  async blockContact({ userId, reason, category, createdBy }) {
    const { block } = await this.request("/blocks", { method: "POST", body: JSON.stringify({ userId, reason, category, createdBy }) });
    return block;
  }

  async unblockContact(blockId, { reviewer, reason } = {}) {
    const { block } = await this.request(`/blocks/${encodeURIComponent(blockId)}`, { method: "PATCH", body: JSON.stringify({ status: "unblocked", reviewer, reason }) });
    return block;
  }

  async listEvents({ limit = 1000 } = {}) {
    const { events } = await this.request(`/events?limit=${encodeURIComponent(String(limit))}`);
    return events || [];
  }
}

function createStore() {
  return new EdgeApiStore();
}

module.exports = {
  EdgeApiStore,
  createStore
};
