function isPairingOnly(env = process.env) {
  return String(env.RAFA_PAIRING_ONLY || "").trim().toLowerCase() === "true";
}

function getTestChatJid(env = process.env) {
  const jid = String(env.RAFA_TEST_CHAT_JID || "").trim();
  if (!jid) return "";
  if (!/^\d{5,20}@(s\.whatsapp\.net|lid)$/u.test(jid)) throw new Error("RAFA_TEST_CHAT_JID must be an exact WhatsApp JID.");
  return jid;
}

function isChatAllowed(userId, testChatJid = "") {
  return !testChatJid || String(userId || "") === testChatJid;
}

function shouldClearLoggedOutAuth(testChatJid = "") {
  return !String(testChatJid || "").trim();
}

module.exports = { getTestChatJid, isChatAllowed, isPairingOnly, shouldClearLoggedOutAuth };
