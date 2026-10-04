const PHONE_JID = /^\d{5,20}(?::\d{1,3})?@(?:s\.whatsapp\.net|c\.us)$/;

function isPhoneJid(value) {
  return typeof value === "string" && PHONE_JID.test(value.trim());
}

async function resolvePhoneJid(userId, message, lidMapping) {
  const key = message?.key || {};
  const alternate = [key.remoteJidAlt, key.participantAlt].find(isPhoneJid);
  if (alternate) return alternate.trim();

  if (!String(userId || "").endsWith("@lid") || typeof lidMapping?.getPNForLID !== "function") return "";
  try {
    const mapped = await lidMapping.getPNForLID(userId);
    return isPhoneJid(mapped) ? mapped.trim() : "";
  } catch {
    return "";
  }
}

module.exports = { isPhoneJid, resolvePhoneJid };
