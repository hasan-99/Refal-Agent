const { detectMessageLanguage } = require("./language");
const { SAFETY_CATEGORIES, classifySafety, safeLocalizedFallback } = require("./safetyPolicy");

function answerFromEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const source = evidence[0];
  const excerpt = String(source.content || "").replace(/\s+/g, " ").trim();
  if (!excerpt || containsProhibitedClaim(excerpt) || containsPromptInjection(excerpt)) return null;
  const answer = excerpt.length > 460 ? `${excerpt.slice(0, 457).replace(/\s+\S*$/, "")}...` : excerpt;
  const citations = [{
    name: source.source_name,
    url: source.source_url,
    documentId: source.document_id,
    chunkId: source.chunk_id || null
  }];
  const sourceLine = citations.map((source) => `${source.name}: ${source.url}`).join(" | ");
  return {
    answer: `${answer}\n\nSource: ${sourceLine}`,
    citations
  };
}

function containsPromptInjection(text) {
  return classifySafety(text).risks.includes(SAFETY_CATEGORIES.PROMPT_INJECTION);
}

function noApprovedEvidenceReply(language = "english") {
  if (language === "arabic") return "لا أملك معلومة معتمدة تؤكد ذلك حاليًا. هل ترغب أن يتابع فريق ريفالكو معك؟";
  if (language === "greek") return "Δεν έχω εγκεκριμένες πληροφορίες για να το επιβεβαιώσω τώρα. Θα θέλατε να επικοινωνήσει μαζί σας η ομάδα της Refalco;";
  return "I don't have approved information to confirm that yet. Would you like the Refalco team to follow up?";
}

function containsProhibitedClaim(text) {
  const answerText = String(text || "").replace(/https?:\/\/\S+/giu, "[source]");
  return /\b(?:invest\w*|returns?|roi|irr|yield|financial advice|registered|registration|company number|legal status|legal entity|legal advice|tax advice|immigration advice|visa|residency|bank approval|loan approval|mortgage approval|permit|licen[cs]e|government approval|company approval)\b|استثمار|عائد|عوائد|ربح|أرباح|مسجل|مسجلة|تسجيل|السجل التجاري|الوضع القانوني|كيان قانوني|استشارة قانونية|ضريبة|هجرة|تأشيرة|إقامة|موافقة البنك|قرض|رهن|رخصة|ترخيص|موافقة حكومية|επένδυση|απόδοση|νομική συμβουλή|φορολογία|βίζα|διαμονή|έγκριση τράπεζας|δάνειο|άδεια|κρατική έγκριση/iu.test(answerText);
}

function restrictedRefalcoReply(text) {
  const language = detectMessageLanguage(text);
  const arabic = language === "arabic";
  const investment = /\b(?:invest\w*|roi|irr|returns?|yield|financial advice)\b|استثمار|عائد|عوائد|ربح|أرباح|επένδυση|απόδοση|επενδυτική συμβουλή/iu.test(text);
  const legal = /\b(?:registered|registration|company number|legal entity|company status|he\s*382352)\b|تسجيل|مسجل|مسجلة|السجل التجاري|كيان قانوني|الوضع القانوني|حالة الشركة|εγγεγραμ|νομική οντότητα/iu.test(text);
  if (investment) return arabic
    ? "لا أستطيع تقديم معلومات عن الاستثمارات أو العوائد المالية أو النصائح المالية. يمكنني المساعدة بمعلومات أخرى معتمدة عن ريفالكو."
    : language === "greek" ? "Η REFAL δεν παρέχει επενδυτικές πληροφορίες, οικονομικές αποδόσεις ή οικονομικές συμβουλές. Μπορώ να βοηθήσω με άλλες εγκεκριμένες πληροφορίες της Refalco."
      : "REFAL cannot provide investment, financial-return, or financial-advice information. I can help with other approved Refalco information.";
  if (legal) return arabic
    ? "لا أقدم معلومات عن تسجيل الشركات أو الوضع القانوني لها. يمكنني المساعدة بمعلومات أخرى معتمدة عن ريفالكو."
    : language === "greek" ? "Η REFAL δεν παρέχει πληροφορίες για την εγγραφή ή το νομικό καθεστώς εταιρειών. Μπορώ να βοηθήσω με άλλες εγκεκριμένες πληροφορίες της Refalco."
      : "REFAL does not provide company registration or legal-status information. I can help with other approved Refalco information.";
  const safety = classifySafety(text);
  return safety.restricted ? safeLocalizedFallback(text, language) : null;
}

module.exports = { answerFromEvidence, containsProhibitedClaim, containsPromptInjection, noApprovedEvidenceReply, restrictedRefalcoReply };
