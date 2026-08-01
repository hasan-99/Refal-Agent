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
    try {
      this.data = raw ? JSON.parse(raw) : { users: {} };
    } catch (error) {
      const backupPath = `${this.filePath}.bak`;
      if (fs.existsSync(backupPath)) {
        const backupRaw = fs.readFileSync(backupPath, "utf8").trim();
        this.data = backupRaw ? JSON.parse(backupRaw) : { users: {} };
        this.save();
        console.error(`User data file was invalid JSON. Recovered from ${backupPath}.`);
        return;
      }

      const brokenPath = `${this.filePath}.corrupt-${Date.now()}.json`;
      fs.renameSync(this.filePath, brokenPath);
      this.data = { users: {} };
      this.save();
      console.error(`User data file was invalid JSON. Moved it to ${brokenPath}.`);
      return;
    }

    if (!this.data.users) this.data.users = {};
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const backupPath = `${this.filePath}.bak`;
    const tempPath = `${this.filePath}.tmp`;
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, backupPath);
    }

    const handle = fs.openSync(tempPath, "w");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(this.data, null, 2)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
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
    const previous = this.data.users[userId];
    this.data.users[userId] = {
      id: userId,
      phone: userId.replace(/@.+$/, ""),
      profile: {},
      step: "name",
      history: previous?.history || [],
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    this.data.users[userId].history.push({
      at: now,
      message: "reset",
      response: "Profile reset"
    });
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

    });
  }
}

module.exports = { JsonStore };
