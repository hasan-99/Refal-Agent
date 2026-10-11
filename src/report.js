const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const writeXlsxFile = require("write-excel-file/node");
const nodemailer = require("nodemailer");
const { redactSensitiveData } = require("./sensitiveData");

function collectKnownPrivateValues(user) {
  const values = new Set();
  for (const value of [user?.phone, user?.profile?.name, user?.profile?.company, user?.profile?.need,
    user?.profile?.address, user?.profile?.email]) {
    const text = String(value || "").trim();
    if (text.length >= 3) values.add(text);
  }
  for (const token of String(user?.profile?.name || "").split(/\s+/u)) {
    if (token.length >= 3) values.add(token);
  }
  const selfIdentification = [
    /\b(?:my name is|call me)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2})(?=\s+(?:and|و|και)(?:\s|$)|[,،;.!?\n]|$)/giu,
    /(?:اسمي(?:\s+هو)?|ناديني|(?:أنا|انا)(?:\s+اسمي)?)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2})(?=\s+(?:و|and)(?:\s|$)|[,،;.!?\n]|$)/gu,
    /(?:Με λένε|το όνομά μου είναι|Ονομάζομαι)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2})(?=\s+(?:and|و|και)(?:\s|$)|[,،;.!?\n]|$)/giu
  ];
  for (const item of user?.history || []) {
    const message = String(item?.message || "");
    for (const pattern of selfIdentification) {
      pattern.lastIndex = 0;
      for (const match of message.matchAll(pattern)) {
        const name = String(match[1] || "").trim();
        if (name.length >= 2) {
          values.add(name);
          for (const token of name.split(/\s+/u)) {
            values.add(token);
            if (/\p{Script=Greek}/u.test(token) && /ος$/iu.test(token)) {
              values.add(token.replace(/ος$/iu, "ο"));
              values.add(token.replace(/ος$/iu, "ου"));
            }
          }
        }
      }
    }
  }
  return [...values];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactReportText(value, privateValues = []) {
  let text = redactSensitiveData(String(value || ""))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/gu, "[phone]")
    .replace(/\b(?:my name is|call me)\s+[^,.!?\n]+/giu, "[personal detail]")
    .replace(/(?:اسمي(?:\s+هو)?|ناديني|(?:أنا|انا)(?:\s+اسمي)?)\s*[^،,.!?\n]+/gu, "[personal detail]")
    .replace(/(?:Με λένε|το όνομά μου είναι|Ονομάζομαι)\s+[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2}(?=\s+(?:and|και|و)(?:\s|$)|[,;.!?\n]|$)/giu, "[personal detail]")
    .replace(/(?:my (?:home )?address is|address\s*:|عنوان(?:ي| العمل| السكن)?|διεύθυνση(?: μου)?|διεύθυνσή μου)(?:\s*(?:is|هو|هي|είναι|:|=))?\s*[^\n]{3,240}/giu, "[address]")
    .replace(/(?:phone|mobile|my number|call me at|رقمي|رقم هاتفي|هاتف(?:ي)?|τηλέφωνό μου|το τηλέφωνό μου|ο αριθμός(?: τηλεφώνου)? μου)\s*(?:is|هو|هي|είναι|:|=)?\s*[+\d٠-٩۰-۹][\d٠-٩۰-۹\s().-]{5,}[\d٠-٩۰-۹]/giu, "[phone]");
  for (const value of privateValues) {
    if (value.length >= 3) text = text.replace(new RegExp(escapeRegExp(value), "giu"), "[personal detail]");
  }
  return text;
}

function conversationRows(data) {
  const users = data.users || {};
  const rows = [];
  const contactRefs = new Map();
  const contactRef = (userId) => {
    const id = String(userId || "");
    if (!contactRefs.has(id)) contactRefs.set(id, `Contact ${String(contactRefs.size + 1).padStart(4, "0")}`);
    return contactRefs.get(id);
  };

  for (const [userKey, user] of Object.entries(users)) {
    const privateValues = collectKnownPrivateValues(user);
    const history = user.history || [];
    if (!history.length) {
      rows.push({
        userId: contactRef(user.id || userKey),
        timestamp: "",
        message: "",
        response: ""
      });
      continue;
    }

    for (const item of history) {
      rows.push({
        userId: contactRef(user.id || userKey),
        timestamp: item.at || "",
        message: redactReportText(item.message, privateValues),
        response: redactReportText(item.response, privateValues)
      });
    }
  }

  return rows;
}

async function resolveUsersData({ store }) {
  if (typeof store?.toJsonData !== "function") {
    throw new Error("A Supabase-backed store is required to generate conversation reports.");
  }
  return store.toJsonData({ includeHistory: true });
}

async function generateConversationReport({ store, outputDir, now = new Date() }) {
  const data = await resolveUsersData({ store });
  const rows = conversationRows(data);
  const userCount = Object.keys(data.users || {}).length;
  const header = (value) => ({ value, fontWeight: "bold" });
  const columns = [
    { header: header("Contact reference"), cell: (row) => ({ value: row.userId }), width: 20 },
    { header: header("Timestamp"), cell: (row) => ({ value: row.timestamp }), width: 28 },
    { header: header("Question/message"), cell: (row) => ({ value: row.message }), width: 48 },
    { header: header("RAFA response"), cell: (row) => ({ value: row.response }), width: 64 }
  ];

  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  const filePath = path.join(outputDir, `whatsapp-conversations-${stamp}.xlsx`);
  await writeXlsxFile(rows, { columns, sheet: "Conversations" }).toFile(filePath);

  return {
    filePath,
    userCount,
    rowCount: rows.length
  };
}

function smtpConfig() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false";

  return {
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  };
}

function assertEmailConfig() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("Missing SMTP_USER or SMTP_PASS in .env.");
  }
}

async function emailReport({ report, to = process.env.REPORT_EMAIL_TO }) {
  const recipient = String(to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error("A valid REPORT_EMAIL_TO recipient must be explicitly configured before sending conversation data.");
  }
  assertEmailConfig();
  const transporter = nodemailer.createTransport(smtpConfig());

  await transporter.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to: recipient,
    subject: `RAFA monthly report - ${new Date().toISOString().slice(0, 10)}`,
    text: [
      "Attached is the RAFA conversation report.",
      "",
      `Users: ${report.userCount}`,
      `Conversation rows: ${report.rowCount}`
    ].join("\n"),
    attachments: [
      {
        filename: path.basename(report.filePath),
        path: report.filePath
      }
    ]
  });
}

async function generateAndEmailReport({ store, now = new Date() }) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "rafa-report-"));
  try {
    const report = await generateConversationReport({ store, outputDir, now });
    await emailReport({ report });
    return { userCount: report.userCount, rowCount: report.rowCount };
  } finally {
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  }
}

module.exports = {
  conversationRows,
  emailReport,
  generateConversationReport,
  generateAndEmailReport,
};
