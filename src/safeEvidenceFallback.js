const { validateResponse, MODEL_DRAFT_THRESHOLDS } = require("./responsePolicy");
const { noApprovedEvidenceReply } = require("./refalcoAnswer");

function selectSafeEvidenceFallback(candidate, { customerMessage = "", evidence = [], language = "english", pricing = false } = {}) {
  const validation = validateResponse(candidate, {
    ...MODEL_DRAFT_THRESHOLDS,
    // Deterministic excerpts can preserve numbered knowledge-base lists. The
    // shared sentence counter sees both the list titles and their explanatory
    // clauses as separate sentences, so allow up to eight here while retaining
    // the same 700-character and one-question limits. Model drafts still use
    // the stricter five-sentence budget.
    maxSentences: 8,
    customerMessage,
    evidence,
    language
  });
  if (validation.valid) return { answer: validation.text, accepted: true, reasons: [] };
  return {
    answer: noApprovedEvidenceReply(language, { pricing }),
    accepted: false,
    reasons: validation.reasons
  };
}

module.exports = { selectSafeEvidenceFallback };
