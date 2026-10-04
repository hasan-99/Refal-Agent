const fs = require("node:fs/promises");
const path = require("node:path");

function shouldRequestPairingCode({ qr, phoneNumber, registered, pairingCodeRequested }) {
  return Boolean(qr && phoneNumber && !registered && !pairingCodeRequested);
}

function pairingFailureMessage(error, phoneNumber = "") {
  const digits = String(phoneNumber).replace(/\D/g, "");
  let detail = String(error?.message || error || "Unknown WhatsApp error")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, "[redacted token]")
    .replace(/\b\+?\d[\d ()-]{7,}\d\b/g, "[redacted number]");
  if (digits.length >= 8) detail = detail.replaceAll(digits, "[redacted number]");
  detail = detail.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  return `WhatsApp could not create a pairing code: ${detail || "Unknown WhatsApp error"}`;
}

async function clearLoggedOutAuth(authPath) {
  const authDirectory = path.resolve(authPath);
  const entries = await fs.readdir(authDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const baileysFile = /^(?:creds\.json|(?:pre-key|session|sender-key|app-state-sync-key|app-state-sync-version|device-list|tctoken|lid-mapping)-[^/\\]+\.json)$/;
  await Promise.all(entries
    .filter((entry) => entry.isFile() && baileysFile.test(entry.name))
    .map((entry) => fs.unlink(path.join(authDirectory, entry.name))));
}

module.exports = { clearLoggedOutAuth, pairingFailureMessage, shouldRequestPairingCode };
