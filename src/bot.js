const path = require("node:path");
const fs = require("node:fs");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { JsonStore } = require("./store");
const { loadCompany } = require("./knowledge");
const { routeMessage } = require("./messageRouter");

const rootDir = path.join(__dirname, "..");
const dataPath = process.env.BOT_DATA_PATH || path.join(rootDir, "data", "users.json");
const companyPath = process.env.COMPANY_CONFIG_PATH || path.join(rootDir, "config", "company.json");
const allowGroups = process.env.ALLOW_GROUPS === "true";
const selfTestPrefix = process.env.SELF_TEST_PREFIX || "!bot";

const store = new JsonStore(dataPath);
const company = loadCompany(companyPath);
const chromePaths = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);
const executablePath = chromePaths.find((chromePath) => fs.existsSync(chromePath));

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "company-bot",
    dataPath: path.join(rootDir, ".wwebjs_auth")
  }),
  puppeteer: {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

client.on("qr", (qr) => {
  console.log("\nScan this QR in WhatsApp: Settings > Linked devices > Link a device\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log(`WhatsApp bot is ready for ${company.companyName}.`);
  console.log(`Data file: ${dataPath}`);
  console.log(`Self-test: send "${selfTestPrefix} hi" from your linked WhatsApp account.`);
});

client.on("authenticated", () => {
  console.log("WhatsApp authenticated.");
});

client.on("auth_failure", (message) => {
  console.error("WhatsApp authentication failed:", message);
});

async function answerMessage(message, userId, text) {
  const response = routeMessage({
    userId,
    text,
    store,
    company
  });

  await message.reply(response);
}

client.on("message", async (message) => {
  try {
    if (message.fromMe) return;
    if (message.from === "status@broadcast") return;
    if (message.from.endsWith("@broadcast")) return;
    if (!message.from.endsWith("@c.us") && !message.from.endsWith("@g.us")) return;
    if (!allowGroups && message.from.endsWith("@g.us")) return;
    if (message.type !== "chat") {
      const response = "Please send text only.";
      store.addHistory(message.from, `[${message.type}]`, response);
      await message.reply(response);
      return;
    }

    await answerMessage(message, message.from, message.body);
  } catch (error) {
    console.error("Failed to handle message:", error);
    await message.reply("Sorry, something went wrong. Please try again.");
  }
});

client.on("message_create", async (message) => {
  try {
    if (!message.fromMe) return;
    if (message.type !== "chat") return;

    const body = String(message.body || "").trim();
    if (!body.toLowerCase().startsWith(selfTestPrefix.toLowerCase())) return;

    const target = message.to || message.from;
    if (target === "status@broadcast") return;
    if (target.endsWith("@broadcast")) return;
    if (!target.endsWith("@c.us") && !target.endsWith("@g.us")) return;
    if (!allowGroups && target.endsWith("@g.us")) return;

    const text = body.slice(selfTestPrefix.length).trim();
    if (!text) {
      await message.reply(`Self-test mode is on. Send "${selfTestPrefix} hi" or "${selfTestPrefix} services".`);
      return;
    }

    await answerMessage(message, `self-test:${target}`, text);
  } catch (error) {
    console.error("Failed to handle self-test message:", error);
    await message.reply("Sorry, something went wrong. Please try again.");
  }
});

client.initialize();
