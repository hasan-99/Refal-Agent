function isPairingOnly(env = process.env) {
  return String(env.RAFA_PAIRING_ONLY || "").trim().toLowerCase() === "true";
}

module.exports = { isPairingOnly };
