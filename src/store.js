const fs = require("node:fs");
const path = require("node:path");

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { users: {} };
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    this.data = raw ? JSON.parse(raw) : { users: {} };
    if (!this.data.users) this.data.users = {};
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  getUser(userId) {
    return this.data.users[userId] || null;
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
      this.save();
    }

    return this.data.users[userId];
  }

  updateUser(userId, updater) {
    const user = this.ensureUser(userId);
    updater(user);
    user.updatedAt = new Date().toISOString();
    this.save();
    return user;
  }

  resetUser(userId) {
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
    this.save();
    return this.data.users[userId];
  }

  addHistory(userId, message, response) {
    this.updateUser(userId, (user) => {
      user.history.push({
        at: new Date().toISOString(),
        message,
        response
      });

      if (user.history.length > 50) {
        user.history = user.history.slice(-50);
      }
    });
  }
}

module.exports = { JsonStore };
