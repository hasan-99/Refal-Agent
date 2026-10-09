// GENERATED FILE — do not edit by hand.
// Source: src/refalcoAnswer.js
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.

function removeSafeDisclaimerClauses(text) {
  const safeDisclaimer = /^(?:i|we|business)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:provide|give|offer)\s+(?:personalized\s+|personalised\s+)?(?:tax|legal|immigration|investment|financial)\s+advice(?:\s+or\s+confirm\s+(?:a\s+)?tax\s+result)?[.!;]?$/iu;
  const safeLegalStatusDisclaimer = /^(?:business|i|we)\s+(?:do not|don['’]t|does not|doesn['’]t)\s+provide\s+(?:information\s+about\s+)?(?:company\s+registration\s+or\s+)?legal[- ]status(?:\s+information)?[.!]?$/iu;
  const safeOutcomeDisclaimer = /^(?:i|we|business)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:guarantee|confirm|promise)\s+(?:that\s+)?(?:bank\s+approval|financing|a\s+loan outcome|a\s+tax result|a\s+permit(?:\s+(?:or\s+)?(?:licen[cs]e|planning))? outcome|(?:a\s+)?licen[cs]e outcome|(?:investment\s+)?returns?)(?:\s*;?\s*the\s+(?:bank|relevant authority)\s+decides)?[.!;]?$/iu;
  const safeEnglishRegulatoryUncertainty = /^(?:i|we|business)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:confirm|determine|verify)\s+(?:whether|if)\s+.{0,100}\b(?:permit|licen[cs]e|eligible|eligibility|approved|approval|regulated|tax result)\b[.!?]?$/iu;
  const safeArabic = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تقديم|إعطاء)\s+(?:نصيحة|استشارة)\s+(?:ضريبية|قانونية|مالية|استثمارية)(?: شخصية)?(?:\s+أو\s+تأكيد\s+نتيجة ضريبية)?[.!؟]?$/u;
  const safeArabicOutcome = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تأكيد|ضمان)\s+(?:نتيجة (?:الرخصة|التصريح|التخطيط|ضريبية)|(?:نتيجة )?موافقة البنك|الحصول على (?:رخصة|تصريح)|عوائد الاستثمار|نتيجة الرخصة أو التصريح أو التخطيط)(?:\s*؛?\s*(?:البنك|الجهة المختصة)\s+(?:هو من يقرر|تقرر))?[.!؟]?$/u;
  const safeArabicLegalStatus = /^لا\s+(?:أقدم|أوفر|أستطيع تقديم)\s+معلومات\s+عن\s+(?:تسجيل الشركات|الوضع القانوني|السجل التجاري)(?:\s+أو\s+(?:الوضع القانوني|تسجيل الشركات))?(?:\s+لها)?[.!؟]?$/u;
  const safeArabicRegulatoryUncertainty = /^(?:لا أستطيع|لا يمكنني|ما فيني|ما بقدر)\s+(?:تأكيد|أكد|تحديد|أتحقق)\s+(?:إذا|إن كان|ما إذا)?\s*.{0,100}(?:ترخيص|رخصة|مؤهل|مقبول|معتمد|خاضع للتنظيم|نتيجة ضريبية)[.!؟]?$/u;
  const safeGreek = /^(?:δεν μπορώ|δεν μπορούμε|η business δεν μπορεί)\s+να\s+(?:παρέχω|παρέχουμε|παρέχει|δώσω|δώσουμε)\s+(?:εξατομικευμένη\s+)?(?:φορολογική|νομική|μεταναστευτική|επενδυτική|οικονομική)\s+συμβουλή(?:\s+ή\s+να\s+επιβεβαιώσω\s+φορολογικό\s+αποτέλεσμα)?[.!;]?$/iu;
  const safeGreekOutcome = /^(?:δεν μπορώ|δεν μπορούμε|η business δεν μπορεί)\s+να\s+(?:εγγυηθώ|εγγυηθούμε|εγγυηθεί|επιβεβαιώσω|επιβεβαιώσουμε)\s+(?:την\s+)?(?:έγκριση τράπεζας|τραπεζική έγκριση|χρηματοδότηση|δάνειο|φορολογικό αποτέλεσμα|αποτέλεσμα (?:άδειας|πολεοδομικής έγκρισης)|αποτέλεσμα για άδεια ή πολεοδομική έγκριση|απόδοση επένδυσης)(?:\s*,?\s*(?:χρηματοδότηση|ή\s+δάνειο))?(?:\s*;?\s*η\s+(?:τράπεζα|αρμόδια αρχή)\s+αποφασίζει)?[.!;]?$/iu;
  const safeGreekBankGuarantee = /^δεν μπορώ να εγγυηθώ τραπεζική έγκριση, χρηματοδότηση ή δάνειο[.!;]?$/iu;
  const safeGreekRegulatoryUncertainty = /^δεν μπορώ να (?:επιβεβαιώσω|καθορίσω|επαληθεύσω)\s+(?:αν|εάν)\s+.{0,100}(?:άδεια|έγκριση|επιλέξιμη|ρυθμιζόμενη|φορολογικό αποτέλεσμα)[.!;]?$/iu;
  return String(text || "").split(/(?<=[.!?؟;；])\s+/u).filter((clause) => {
    const value = clause.trim();
    return !(safeDisclaimer.test(value) || safeLegalStatusDisclaimer.test(value) || safeOutcomeDisclaimer.test(value) || safeEnglishRegulatoryUncertainty.test(value) || safeArabic.test(value) || safeArabicOutcome.test(value) || safeArabicLegalStatus.test(value) || safeArabicRegulatoryUncertainty.test(value) || safeGreek.test(value) || safeGreekOutcome.test(value) || safeGreekBankGuarantee.test(value) || safeGreekRegulatoryUncertainty.test(value));
  }).join(" ");
}

export function containsProhibitedClaim(text) {
  const answerText = String(text || "").replace(/https?:\/\/\S+/giu, "[source]");
  const claimText = removeSafeDisclaimerClauses(answerText);
  const unsupportedSuitability = /\b(?:straightforward|standard|ordinary|simple)\s+(?:business\s+)?activity\b.{0,70}\b(?:suitable|eligible|approved|should fit|will fit|is allowed|can proceed)\b|\b(?:activity|business activity|industry)\b.{0,60}\b(?:is suitable|is eligible|is approved|should fit|will fit|is allowed)\b|(?:نشاط|النشاط).{0,50}(?:مناسب|مقبول|مؤهل|معتمد|ما في مشكلة|يمكن البدء)|(?:δραστηριότητα|κλάδος).{0,50}(?:κατάλληλη|επιλέξιμη|εγκρίνεται|μπορεί να προχωρήσει)/iu;
  // Absolute-certainty claims. Deliberately NOT a blanket ban on "100%":
  // "a non-resident can own 100% of a Cyprus company" is a correct and useful
  // fact, and blocking it would push REFAL into vagueness about ownership. Only
  // 100% paired with an OUTCOME word is a prohibited guarantee.
  // No \b after `%`: the percent sign is not a word character, so `100\s*%\b`
  // can never match. The same trap that killed the original pattern.
  const absoluteCertainty = /\b100\s*(?:%|percent)[^.!?]{0,40}\b(?:success|approval|approved|guaranteed|certain|sure|accept\w*)\b|\b(?:success|approval|guarantee\w*|certain)\b[^.!?]{0,40}\b100\s*(?:%|percent)|(?:100\s*٪|مئة بالمئة|مائة بالمائة)[^.؟!]{0,40}(?:نجاح|موافقة|ضمان|مضمون)|(?:نجاح|موافقة|ضمان|مضمون)[^.؟!]{0,40}(?:100\s*٪|مئة بالمئة)|(?:100\s*%|εκατό τοις εκατό)[^.;!]{0,40}(?:επιτυχία|έγκριση|εγγύηση)/iu;
  if (absoluteCertainty.test(claimText)) return true;

  return unsupportedSuitability.test(claimText) || /\b(?:investment\s+(?:returns?|roi|irr|yield|advice|recommendations?)|(?:returns?|roi|irr|yield|profits?)\b.{0,60}\binvest\w*|(?:returns?|roi|irr|yield)\s+(?:on|from)\s+(?:an?\s+)?investment|financial advice|(?:is|are|was|were|has been|have been)\s+(?:[\p{L}0-9'&.-]+\s+){0,4}(?:legally\s+)?registered|registration number|company number|legal status|legal entity|legal advice|tax advice|immigration advice|visa|residency|bank approval|loan approval|mortgage approval|permit|licen[cs]e|government approval|company approval)\b|(?:عوائد|عائد|ربح|أرباح)\s+(?:الاستثمار|استثماري)|(?:استثمار|استثماري)\s+(?:بعائد|بعوائد|مربح|مضمون)|استشارة استثمارية|موافقة مضمونة|ضمان الموافقة|الموافقة مضمونة|عائد مضمون|عوائد مضمونة|أرباح مضمونة|ربح مضمون|الشركة\s+(?:مسجلة|مسجل)\s+(?:في|بقبرص)|السجل التجاري|الوضع القانوني|كيان قانوني|استشارة قانونية|استشارة ضريبية|معدل الضريبة|نسبة الضريبة|هجرة|تأشيرة|إقامة|موافقة البنك|قرض|رهن|رخصة|ترخيص|موافقة حكومية|(?:ستحصل|سيحصل|سيتم منحك).{0,35}(?:الموافقة|موافقة|رخصة|ترخيص)|επενδυτικ(?:ές|ή)\s+αποδόσεις|απόδοση\s+(?:επένδυσης|επενδυτική)|επενδυτική\s+συμβουλή|σίγουρη έγκριση|εγγυημένη έγκριση|εγγυημένη απόδοση|νομική συμβουλή|φορολογική συμβουλή|εταιρεία\s+(?:είναι\s+)?εγγεγραμμένη|νομική οντότητα|βίζα|διαμονή|έγκριση τράπεζας|δάνειο|άδεια|κρατική έγκριση|θα εγκριθεί.{0,40}(?:άδεια|έγκριση)|θα (?:πάρω|λάβω).{0,40}(?:άδεια|έγκριση)/iu.test(claimText);
}
