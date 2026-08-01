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
});

client.on("authenticated", () => {
  console.log("WhatsApp authenticated.");
});

client.on("auth_failure", (message) => {
  console.error("WhatsApp authentication failed:", message);
});

client.on("message", async (message) => {
  try {
    if (message.fromMe) return;
    if (!allowGroups && message.from.endsWith("@g.us")) return;
    if (message.type !== "chat") {
      await message.reply("Please send text only.");
      return;
    }

    const response = routeMessage({
      userId: message.from,
      text: message.body,
      store,
      company
    });

    await message.reply(response);
  } catch (error) {
    console.error("Failed to handle message:", error);
    await message.reply("Sorry, something went wrong. Please try again.");
  }
});

client.initialize();
