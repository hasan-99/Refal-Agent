// GENERATED FILE — do not edit by hand.
// Source: src/refalcoAnswer.js
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.

import { evaluateAnswerClaims, isApprovedEvidence, containsGuaranteeMarker, containsPersonalizedConclusion } from "./claimPolicy.mjs";
import { violatesOutputGuards } from "./outputGuards.mjs";

function removeSafeDisclaimerClauses(text) {
  const safeDisclaimer = /^(?:i|we|business)\s+(?:can(?:not|['’]t)|cannot|do not|don['’]t)\s+(?:provide|give|offer)\s+(?:personalized\s+|personalised\s+)?(?:tax|legal|immigration|investment|financial)\s+advice(?:\s+or\s+confirm\s+(?:a\s+)?tax\s+result)?[.!;]?$/iu;
  // P2.6 defect CLAIM-4, English half. The anchored pattern above requires the
  // clause to END at "advice", so REFAL's own approved English investment
  // fallback — "I can't provide investment advice, expected returns, or
  // financial guarantees." — was NOT exempt and the blanket topic regex deleted
  // it. That is pre-M2 behaviour and it is still live on the no-evidence path,
  // which is the common case while the corpus is empty. A refusal that ENUMERATES
  // what it refuses is still a refusal; the enumeration may not contain a verb,
  // which is what keeps this from swallowing an affirmative follow-on clause.
  const safeEnumeratedRefusal = /^(?:i|we|refal|refalco|business)\s+(?:can(?:not|['’]t)|cannot|do(?:es)?\s+not|don['’]t|will\s+not|won['’]t)\s+(?:provide|give|offer|share|discuss|quote)\s+[^.!?;]{0,120}$/iu;
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
    return !(safeDisclaimer.test(value) || safeEnumeratedRefusal.test(value) || safeLegalStatusDisclaimer.test(value) || safeOutcomeDisclaimer.test(value) || safeEnglishRegulatoryUncertainty.test(value) || safeArabic.test(value) || safeArabicOutcome.test(value) || safeArabicLegalStatus.test(value) || safeArabicRegulatoryUncertainty.test(value) || safeGreek.test(value) || safeGreekOutcome.test(value) || safeGreekBankGuarantee.test(value) || safeGreekRegulatoryUncertainty.test(value));
  }).join(" ");
}

const UNSUPPORTED_SUITABILITY = /\b(?:straightforward|standard|ordinary|simple)\s+(?:business\s+)?activity\b.{0,70}\b(?:suitable|eligible|approved|should fit|will fit|is allowed|can proceed)\b|\b(?:activity|business activity|industry)\b.{0,60}\b(?:is suitable|is eligible|is approved|should fit|will fit|is allowed)\b|(?:نشاط|النشاط).{0,50}(?:مناسب|مقبول|مؤهل|معتمد|ما في مشكلة|يمكن البدء)|(?:δραστηριότητα|κλάδος).{0,50}(?:κατάλληλη|επιλέξιμη|εγκρίνεται|μπορεί να προχωρήσει)/iu;
const ABSOLUTE_CERTAINTY = /\b100\s*(?:%|percent)[^.!?]{0,40}\b(?:success|approval|approved|guaranteed|certain|sure|accept\w*)\b|\b(?:success|approval|guarantee\w*|certain)\b[^.!?]{0,40}\b100\s*(?:%|percent)|(?:100\s*٪|مئة بالمئة|مائة بالمائة)[^.؟!]{0,40}(?:نجاح|موافقة|ضمان|مضمون)|(?:نجاح|موافقة|ضمان|مضمون)[^.؟!]{0,40}(?:100\s*٪|مئة بالمئة)|(?:100\s*%|εκατό τοις εκατό)[^.;!]{0,40}(?:επιτυχία|έγκριση|εγγύηση)/iu;
const BLANKET_RESTRICTED_TOPICS = /\b(?:investment\s+(?:returns?|roi|irr|yield|advice|recommendations?)|(?:returns?|roi|irr|yield|profits?)\b.{0,60}\binvest\w*|(?:returns?|roi|irr|yield)\s+(?:on|from)\s+(?:an?\s+)?investment|financial advice|(?:is|are|was|were|has been|have been)\s+(?:[\p{L}0-9'&.-]+\s+){0,4}(?:legally\s+)?registered|registration number|company number|legal status|legal entity|legal advice|tax advice|immigration advice|visa|residency|bank approval|loan approval|mortgage approval|permit|licen[cs]e|government approval|company approval)\b|(?:عوائد|عائد|ربح|أرباح)\s+(?:الاستثمار|استثماري)|(?:استثمار|استثماري)\s+(?:بعائد|بعوائد|مربح|مضمون)|استشارة استثمارية|موافقة مضمونة|ضمان الموافقة|الموافقة مضمونة|عائد مضمون|عوائد مضمونة|أرباح مضمونة|ربح مضمون|الشركة\s+(?:مسجلة|مسجل)\s+(?:في|بقبرص)|السجل التجاري|الوضع القانوني|كيان قانوني|استشارة قانونية|استشارة ضريبية|معدل الضريبة|نسبة الضريبة|هجرة|تأشيرة|إقامة|موافقة البنك|قرض|رهن|رخصة|ترخيص|موافقة حكومية|(?:ستحصل|سيحصل|سيتم منحك).{0,35}(?:الموافقة|موافقة|رخصة|ترخيص)|επενδυτικ(?:ές|ή)\s+αποδόσεις|απόδοση\s+(?:επένδυσης|επενδυτική)|επενδυτική\s+συμβουλή|σίγουρη έγκριση|εγγυημένη έγκριση|εγγυημένη απόδοση|νομική συμβουλή|φορολογική συμβουλή|εταιρεία\s+(?:είναι\s+)?εγγεγραμμένη|νομική οντότητα|βίζα|διαμονή|έγκριση τράπεζας|δάνειο|άδεια|κρατική έγκριση|θα εγκριθεί.{0,40}(?:άδεια|έγκριση)|θα (?:πάρω|λάβω).{0,40}(?:άδεια|έγκριση)/iu;

export function containsUnconditionalProhibition(text, options = {}) {
  const claimText = removeSafeDisclaimerClauses(String(text || "").replace(/https?:\/\/\S+/giu, "[source]"));
  if (ABSOLUTE_CERTAINTY.test(claimText) || UNSUPPORTED_SUITABILITY.test(claimText)) return true;
  // P2.6 finding G-01. A bare guarantee with no restricted-topic noun beside it
  // matched neither the blanket regex nor any output guard. It is unconditional
  // by definition, so it is tested here on both branches. `containsGuaranteeMarker`
  // applies claimPolicy's refusal strips, so REFAL's own "I cannot guarantee..."
  // does not register.
  if (containsGuaranteeMarker(claimText) || containsPersonalizedConclusion(claimText)) return true;
  // P2.6 findings G-05, G-06, G-07. A bank-approval promise, an ROI or yield
  // claim, a personalized VAT verdict, an unsourced reservation deposit and a
  // question about another customer are prohibited because of WHAT they assert.
  // Approved evidence is irrelevant to all five, so they belong on this side of
  // the branch, not in the evidence-gated classifier.
  return violatesOutputGuards(claimText, { reservationSource: options?.reservationSource, language: options?.language });
}

function containsProhibitedClaimLegacy(text) {
  const claimText = removeSafeDisclaimerClauses(String(text || "").replace(/https?:\/\/\S+/giu, "[source]"));
  if (ABSOLUTE_CERTAINTY.test(claimText)) return true;
  return UNSUPPORTED_SUITABILITY.test(claimText) || BLANKET_RESTRICTED_TOPICS.test(claimText);
}

export function containsProhibitedClaim(text, options = {}) {
  // Runs BEFORE the branch, not inside the evidence arm. A guarantee, an ROI
  // claim, a personalized VAT verdict, an unsourced deposit figure and another
  // customer's data are prohibited whether or not a chunk was retrieved, so
  // gating them on evidence would have left the whole no-evidence path, which
  // is the common case today with an empty corpus, unprotected by them.
  //
  // This makes the gate a strict SUPERSET of the pre-M2 behaviour rather than
  // byte-identical to it. That is a deliberate strengthening, and it is why
  // src/guardrailRegression.test.js asserts implication (legacy blocked implies
  // this blocks) rather than equality.
  if (containsUnconditionalProhibition(text, options)) return true;
  const supplied = Array.isArray(options?.evidence) ? options.evidence.filter(isApprovedEvidence) : [];
  if (!supplied.length) return containsProhibitedClaimLegacy(text);
  const claimText = removeSafeDisclaimerClauses(String(text || "").replace(/https?:\/\/\S+/giu, "[source]"));
  if (!claimText.trim()) return false;
  return !evaluateAnswerClaims(claimText, { evidence: supplied, language: options?.language }).allowed;
}
