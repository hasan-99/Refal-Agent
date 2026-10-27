import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { restrictedRefalcoReply } = require("../src/refalcoAnswer.js");
const { detectMessageLanguage } = require("../src/language.js");

function isFreeQuotaError(error) {
  return /free-models-per-day|daily (?:free[- ]model|request) (?:limit|quota)|rate limit exceeded/i.test(String(error?.message || error || ""));
}

function dashboardFailureReply({ text, error }) {
  const refusal = restrictedRefalcoReply(text);
  if (refusal) return refusal;
  const language = detectMessageLanguage(text);
  const quota = isFreeQuotaError(error);

  if (quota) {
    if (language === "arabic") return "تم بلوغ الحد اليومي للنموذج. حُفظت رسالتك، لكن لا أستطيع إنشاء رد مستند إلى المعرفة المعتمدة الآن. حاول مجددًا بعد إعادة تعيين الحد.";
    if (language === "greek") return "Συμπληρώθηκε το ημερήσιο όριο του μοντέλου. Το μήνυμά σας αποθηκεύτηκε, αλλά δεν μπορώ να δημιουργήσω τεκμηριωμένη απάντηση τώρα. Δοκιμάστε ξανά όταν ανανεωθεί το όριο.";
    return "The model's daily limit has been reached. Your message is saved, but I can't generate an answer from verified knowledge right now. Try again after the limit resets.";
  }

  if (language === "arabic") return "تعذر الوصول إلى خدمة الإجابة المعتمدة مؤقتًا. حُفظت رسالتك؛ يرجى المحاولة مجددًا بعد قليل.";
  if (language === "greek") return "Η υπηρεσία επαληθευμένων απαντήσεων δεν είναι προσωρινά διαθέσιμη. Το μήνυμά σας αποθηκεύτηκε· δοκιμάστε ξανά σύντομα.";
  return "The verified answer service is temporarily unavailable. Your message is saved; please try again shortly.";
}

export { dashboardFailureReply, isFreeQuotaError };
