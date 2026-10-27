const assert = require("node:assert/strict");
const { test } = require("node:test");
const nodemailer = require("nodemailer");
const { conversationRows, emailReport } = require("./report");

test("conversation export pseudonymizes contacts and redacts known identifiers from transcript text", () => {
  const rows = conversationRows({ users: {
    "35799123456@s.whatsapp.net": {
      id: "35799123456@s.whatsapp.net",
      phone: "+357 99 123456",
      profile: { name: "Hasan Owner", company: "Secret Holdings Ltd", need: "Tax planning" },
      history: [{
        at: "2026-10-11T10:00:00.000Z",
        message: "My name is Hasan Owner, email hasan@example.com, call me at +357 99 123456. My IBAN is CY17002001280000001200527600 and backup number 35799123457",
        response: "I can help, Hasan."
      }]
    },
    "another@s.whatsapp.net": { id: "another@s.whatsapp.net", history: [{ at: "2026-10-11T10:01:00.000Z", message: "Hello", response: "Hello" }] }
  } });

  assert.equal(rows[0].userId, "Contact 0001");
  assert.equal(rows[1].userId, "Contact 0002");
  assert.equal(rows[0].timestamp, "2026-10-11T10:00:00.000Z");
  assert.match(rows[0].message, /\[personal detail\]/u);
  assert.match(rows[0].message, /\[email\]/u);
  assert.match(rows[0].message, /\[phone\]/u);
  assert.match(rows[0].message, /\[redacted\]/u);
  assert.doesNotMatch(JSON.stringify(rows), /35799123456|hasan@example\.com|Hasan Owner|Secret Holdings|CY17002001280000001200527600/u);
  assert.doesNotMatch(JSON.stringify(rows), /Hasan/u);
});

test("conversation export redacts Arabic personal names, localized phone numbers, and labeled addresses", () => {
  const rows = conversationRows({ users: {
    customer: {
      id: "customer",
      history: [{
        message: "اسمي حسن، رقمي ٠٥٠١٢٣٤٥٦٧ وعنواني شارع مكاريوس 12، نيقوسيا",
        response: "أهلاً حسن، رح أساعدك."
      }]
    }
  } });
  assert.match(rows[0].message, /\[personal detail\]/u);
  assert.match(rows[0].message, /\[phone\]/u);
  assert.match(rows[0].message, /\[address\]/u);
  assert.doesNotMatch(JSON.stringify(rows), /حسن|٠٥٠١٢٣٤٥٦٧|مكاريوس|نيقوسيا/u);
});

test("conversation export redacts Greek self-identification and names repeated by the agent", () => {
  const rows = conversationRows({ users: {
    customer: {
      id: "customer",
      history: [{
        message: "Με λένε Νίκο και το τηλέφωνό μου είναι 99123456",
        response: "Χάρηκα, Νίκο. Θα βοηθήσω."
      }]
    }
  } });
  assert.match(rows[0].message, /\[personal detail\]/u);
  assert.match(rows[0].message, /\[phone\]/u);
  assert.doesNotMatch(JSON.stringify(rows), /Νίκο|99123456/u);
});

test("conversation export redacts alternate Arabic and Greek self-identification and complete addresses", () => {
  const rows = conversationRows({ users: {
    arabic: { id: "arabic", history: [{
      message: "انا حسن أحمد، عنوان العمل: شارع مكاريوس 12، نيقوسيا",
      response: "أهلاً حسن أحمد."
    }] },
    greek: { id: "greek", history: [{
      message: "Ονομάζομαι Νίκος και ο αριθμός τηλεφώνου μου είναι 99123456",
      response: "Χάρηκα, Νίκο."
    }] }
  } });
  assert.match(rows[0].message, /\[personal detail\]/u);
  assert.match(rows[0].message, /\[address\]/u);
  assert.doesNotMatch(rows[0].response, /حسن أحمد/u);
  assert.match(rows[1].message, /\[personal detail\]/u);
  assert.match(rows[1].message, /\[phone\]/u);
  assert.doesNotMatch(JSON.stringify(rows), /حسن أحمد|مكاريوس|نيقوسيا|Νίκος|Νίκο|99123456/u);
});

test("conversation export redacts the full address through city and postcode", () => {
  const rows = conversationRows({ users: {
    english: { id: "english", history: [{ message: "My address is 12 Arch. Makarios Ave, Nicosia, Cyprus 1010." }] },
    greek: { id: "greek", history: [{ message: "Η διεύθυνσή μου είναι Μακαρίου 12, Λευκωσία, 1065." }] }
  } });
  assert.doesNotMatch(JSON.stringify(rows), /Makarios|Nicosia|1010|Λευκωσία|1065/u);
});

test("conversation reports require an explicitly configured recipient", async (t) => {
  const oldRecipient = process.env.REPORT_EMAIL_TO;
  const oldUser = process.env.SMTP_USER;
  const oldPass = process.env.SMTP_PASS;
  process.env.REPORT_EMAIL_TO = "";
  process.env.SMTP_USER = "sender@example.test";
  process.env.SMTP_PASS = "test-password";
  t.after(() => {
    for (const [key, value] of [["REPORT_EMAIL_TO", oldRecipient], ["SMTP_USER", oldUser], ["SMTP_PASS", oldPass]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await assert.rejects(
    emailReport({ report: { filePath: "report.xlsx", userCount: 1, rowCount: 1 } }),
    /REPORT_EMAIL_TO.*explicitly configured/
  );
  await assert.rejects(
    emailReport({ report: { filePath: "report.xlsx", userCount: 1, rowCount: 1 }, to: "not-an-email" }),
    /REPORT_EMAIL_TO.*explicitly configured/
  );
});

test("conversation reports send only to the explicit configured recipient", async (t) => {
  const oldRecipient = process.env.REPORT_EMAIL_TO;
  const oldUser = process.env.SMTP_USER;
  const oldPass = process.env.SMTP_PASS;
  const originalCreateTransport = nodemailer.createTransport;
  let message;
  process.env.REPORT_EMAIL_TO = "reports@example.test";
  process.env.SMTP_USER = "sender@example.test";
  process.env.SMTP_PASS = "test-password";
  nodemailer.createTransport = () => ({ sendMail: async (options) => { message = options; } });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
    for (const [key, value] of [["REPORT_EMAIL_TO", oldRecipient], ["SMTP_USER", oldUser], ["SMTP_PASS", oldPass]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await emailReport({ report: { filePath: "report.xlsx", userCount: 1, rowCount: 1 } });
  assert.equal(message.to, "reports@example.test");
});
