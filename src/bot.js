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
const logPath = process.env.BOT_LOG_PATH || path.join(rootDir, "logs", "events.log");
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

function logEvent(event, fields = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const entry = {
    at: new Date().toISOString(),
    event,
    ...fields
  };
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function messagePreview(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 120);
}

function isSupportedChatId(chatId) {
  if (!chatId) return false;
  if (chatId === "status@broadcast") return false;
  if (chatId.endsWith("@broadcast")) return false;
  if (chatId.endsWith("@g.us")) return allowGroups;
  return chatId.endsWith("@c.us");
}

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
  console.log(`Log file: ${logPath}`);
  console.log(`Self-test: send "${selfTestPrefix} hi" from your linked WhatsApp account.`);
  logEvent("ready", { company: company.companyName });
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
    logEvent("message", {
      from: message.from,
      to: message.to,
      fromMe: message.fromMe,
      type: message.type,
      body: messagePreview(message.body)
    });

    if (message.fromMe) return;
    if (!isSupportedChatId(message.from)) {
      logEvent("ignored", { reason: "unsupported_chat", from: message.from, type: message.type });
      return;
    }

    if (message.type !== "chat") {
      const response = "Please send text only.";
      store.addHistory(message.from, `[${message.type}]`, response);
      await message.reply(response);
      return;
    }

    await answerMessage(message, message.from, message.body);
    logEvent("replied", { mode: "customer", to: message.from });
  } catch (error) {
    console.error("Failed to handle message:", error);
    logEvent("error", { mode: "customer", message: error.message });
    await message.reply("Sorry, something went wrong. Please try again.");
  }
});

client.on("message_create", async (message) => {
  try {
    logEvent("message_create", {
      from: message.from,
      to: message.to,
      fromMe: message.fromMe,
      type: message.type,
      body: messagePreview(message.body)
    });

    if (!message.fromMe) return;
    if (message.type !== "chat") return;

    const body = String(message.body || "").trim();
    if (!body.toLowerCase().startsWith(selfTestPrefix.toLowerCase())) return;

    const target = message.to || message.from;
    if (!isSupportedChatId(target)) {
      logEvent("ignored", { reason: "unsupported_self_test_target", target });
      await message.reply("Self-test only works in a normal person chat. Open a chat with yourself or another number, then send \"!bot hi\".");
      return;
    }

    const text = body.slice(selfTestPrefix.length).trim();
    if (!text) {
      await message.reply(`Self-test mode is on. Send "${selfTestPrefix} hi" or "${selfTestPrefix} services".`);
      return;
    }

    await answerMessage(message, `self-test:${target}`, text);
    logEvent("replied", { mode: "self-test", to: target });
  } catch (error) {
    console.error("Failed to handle self-test message:", error);
    logEvent("error", { mode: "self-test", message: error.message });
    await message.reply("Sorry, something went wrong. Please try again.");
  }
});

client.initialize();
