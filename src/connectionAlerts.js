const nodemailer = require("nodemailer");

const DISCONNECT_ALERT_TEXT =
  "⚠️ بوت الواتساب انقطع الاتصال ولم يتمكن من إعادة الاتصال تلقائياً، الرجاء التحقق.";

function smtpConfig() {
  return {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  };
}

function alertRecipient() {
  return process.env.ALERT_EMAIL_TO || process.env.REPORT_EMAIL_TO || "hasan.cy99@gmail.com";
}

async function sendConnectionEmail({ subject, text }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("Missing SMTP_USER or SMTP_PASS in .env.");
  }

  const transporter = nodemailer.createTransport(smtpConfig());
  await transporter.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to: alertRecipient(),
    subject,
    text
  });
}

async function sendDisconnectAlert({ disconnectedAt }) {
  await sendConnectionEmail({
    subject: "RAFA disconnected",
    text: [
      DISCONNECT_ALERT_TEXT,
      "",
      `Disconnected at: ${disconnectedAt.toISOString()}`
    ].join("\n")
  });
}

async function sendRecoveryAlert({ disconnectedAt, recoveredAt }) {
  await sendConnectionEmail({
    subject: "RAFA reconnected",
    text: [
      "RAFA connection recovered.",
      "",
      `Disconnected at: ${disconnectedAt.toISOString()}`,
      `Recovered at: ${recoveredAt.toISOString()}`
    ].join("\n")
  });
}

module.exports = {
  DISCONNECT_ALERT_TEXT,
  sendDisconnectAlert,
  sendRecoveryAlert
};
