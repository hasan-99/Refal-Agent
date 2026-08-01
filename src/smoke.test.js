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

const saved = store.getUser(userId);
assert.equal(saved.profile.name, "Hasan");
assert.equal(saved.profile.company, "Qualia");
assert.equal(saved.profile.need, "WhatsApp automation");
assert.ok(saved.history.length >= 6);

console.log("Smoke test passed.");
