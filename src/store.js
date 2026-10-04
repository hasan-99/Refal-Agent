const { redactSensitiveData } = require("./sensitiveData");

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
    user.history = [];
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

  addHistory(userId, message, response) {
    let turn;
    this.updateUser(userId, (user) => {
      turn = { at: new Date().toISOString(), message: redactSensitiveData(message), response: redactSensitiveData(response) };
      user.history.push(turn);
    });
    return turn;
  }

  allUsers() {
    return Object.values(this.data.users);
  }

  toJsonData() {
    return this.data;
  }
}

module.exports = { MemoryStore };
