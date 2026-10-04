const { classifySafety, SAFETY_CATEGORIES } = require("./safetyPolicy");

// When a customer accidentally includes a secret and a separate safe request,
// keep only complete, non-sensitive clauses for routing. The original turn
// must still be omitted from durable history.
function extractSafeRequestFromPrivacyMessage(value) {
  const clauses = String(value || "").match(/[^.!?؟;؛\n]+[.!?؟;؛]?/gu) || [];
  const safeClauses = clauses.filter((clause) => !classifySafety(clause).risks.includes(SAFETY_CATEGORIES.PRIVACY));
  const safeRequest = safeClauses.join(" ").replace(/\s+/gu, " ").trim();
  if (!safeRequest || classifySafety(safeRequest).risks.length) return "";
  return safeRequest;
}

module.exports = { extractSafeRequestFromPrivacyMessage };
