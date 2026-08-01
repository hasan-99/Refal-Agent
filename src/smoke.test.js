const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JsonStore } = require("./store");
const { loadCompany, findCompanyAnswer } = require("./knowledge");
const { routeMessage } = require("./messageRouter");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-company-bot-"));
const store = new JsonStore(path.join(tempDir, "users.json"));
const company = loadCompany(path.join(__dirname, "..", "config", "company.json"));
const userId = "35799111222@c.us";

assert.match(routeMessage({ userId, text: "hello", store, company }), /What is your name/);
assert.match(routeMessage({ userId, text: "Hasan", store, company }), /company or project/);
assert.match(routeMessage({ userId, text: "Qualia", store, company }), /need help/);
assert.match(routeMessage({ userId, text: "WhatsApp automation", store, company }), /Saved details/);
assert.match(routeMessage({ userId, text: "services", store, company }), /websites/i);
assert.match(routeMessage({ userId, text: "profile", store, company }), /Hasan/);
assert.match(findCompanyAnswer(company, "how can I contact you"), /email/i);

const firstQuestionStore = new JsonStore(path.join(tempDir, "first-question-users.json"));
const firstQuestionResponse = routeMessage({
  userId: "35799111333@c.us",
  text: "what services do you do?",
  store: firstQuestionStore,
  company
});
assert.match(firstQuestionResponse, /websites/i);
assert.match(firstQuestionResponse, /What is your name/);
assert.equal(firstQuestionStore.getUser("35799111333@c.us").profile.name, undefined);

const invalidStore = new JsonStore(path.join(tempDir, "invalid-users.json"));
assert.match(routeMessage({ userId: "35799111444@c.us", text: "?", store: invalidStore, company }), /could not save/);
assert.equal(invalidStore.getUser("35799111444@c.us").profile.name, undefined);

const saved = store.getUser(userId);
assert.equal(saved.profile.name, "Hasan");
assert.equal(saved.profile.company, "Qualia");
assert.equal(saved.profile.need, "WhatsApp automation");
assert.ok(saved.history.length >= 6);

const historyLength = saved.history.length;
assert.match(routeMessage({ userId, text: "reset", store, company }), /What is your name/);
assert.ok(store.getUser(userId).history.length > historyLength);
assert.equal(store.getUser(userId).profile.name, undefined);

console.log("Smoke test passed.");
