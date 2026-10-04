const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const writeXlsxFile = require("write-excel-file/node");
const nodemailer = require("nodemailer");

const DEFAULT_REPORT_TO = "hasan.cy99@gmail.com";

function conversationRows(data) {
  const users = data.users || {};
  const rows = [];

  for (const user of Object.values(users)) {
    const history = user.history || [];
    if (!history.length) {
      rows.push({
        userId: user.id,
        phone: user.phone,
        name: user.profile?.name || "",
        company: user.profile?.company || "",
        need: user.profile?.need || "",
        timestamp: "",
        message: "",
        response: ""
      });
      continue;
    }

    for (const item of history) {
      rows.push({
        userId: user.id,
        phone: user.phone,
        name: user.profile?.name || "",
        company: user.profile?.company || "",
        need: user.profile?.need || "",
        timestamp: item.at || "",
        message: item.message || "",
        response: item.response || ""
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
    { header: header("User ID"), cell: (row) => ({ value: row.userId }), width: 34 },
    { header: header("Phone"), cell: (row) => ({ value: row.phone }), width: 18 },
    { header: header("Name"), cell: (row) => ({ value: row.name }), width: 22 },
    { header: header("Company/project"), cell: (row) => ({ value: row.company }), width: 24 },
    { header: header("Need"), cell: (row) => ({ value: row.need }), width: 30 },
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

async function emailReport({ report, to = process.env.REPORT_EMAIL_TO || DEFAULT_REPORT_TO }) {
  assertEmailConfig();
  const transporter = nodemailer.createTransport(smtpConfig());

  await transporter.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to,
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
  DEFAULT_REPORT_TO,
  conversationRows,
  generateConversationReport,
  generateAndEmailReport,
};
