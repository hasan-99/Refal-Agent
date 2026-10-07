import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { answerFromEvidence, containsProhibitedClaim, restrictedRefalcoReply } = require("../src/refalcoAnswer.js");
const { detectMessageLanguage } = require("../src/language.js");

function isCompanyKnowledgeQuestion(text) {
  return /\b(business|company|group|portfolio|project|service|leadership|ceo|approach|principle|operating)\b|الشركة|المجموعة|الشركة|مشروع|المشاريع|القيادة|الرئيس التنفيذي/iu.test(text);
}

function isFreeQuotaError(error) {
  return /free-models-per-day|daily (?:free[- ]model|request) (?:limit|quota)|rate limit exceeded/i.test(String(error?.message || error || ""));
}

function dashboardFailureReply({ text, evidence = [], error }) {
  const refusal = restrictedRefalcoReply(text);
  if (refusal) return refusal;

  const language = detectMessageLanguage(text);
  const quota = isFreeQuotaError(error);
  if (quota && isCompanyKnowledgeQuestion(text)) {
    const grounded = answerFromEvidence(evidence);
    if (grounded && !containsProhibitedClaim(grounded.answer)) {
      const lead = language === "arabic"
        ? "تم بلوغ الحد اليومي للنموذج المجاني. هذا مقتطف من مصدر الشركة المعتمد:"
        : "The free model has reached its daily limit. Here is an approved the business source excerpt:";
      const sourceUrl = grounded.citations?.[0]?.url;
      const citation = typeof sourceUrl === "string" && /^https:\/\//iu.test(sourceUrl) ? `\n\n${language === "arabic" ? "المصدر" : "Source"}: ${sourceUrl}` : "";
      return `${lead}\n\n${grounded.answer}${citation}`;
    }
  }

  if (quota) return language === "arabic"
    ? "تم بلوغ الحد اليومي للنموذج المجاني. حُفظت رسالتك، لكن لا أستطيع إنشاء رد الآن. حاول مجددًا بعد إعادة تعيين الحد اليومي."
    : "The free model's daily limit has been reached. Your message is saved, but I can't generate a reply right now. Try again after the limit resets.";

  return language === "arabic"
    ? "تعذر الوصول إلى النموذج مؤقتًا. حُفظت رسالتك؛ يرجى المحاولة مجددًا بعد قليل."
    : "RAFA could not reach its model just now. Your message is saved; please try again shortly.";
}

export { dashboardFailureReply, isFreeQuotaError };
