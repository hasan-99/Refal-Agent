"use strict";

// Deterministic routing metadata for the high-stakes opportunities identified
// in MB-F56..MB-F62 and Master Plan P6.6. This module deliberately produces no
// customer copy and has no pricing/estimating dependency.
const ROUTE = "senior_consultant";

const CLASSES = Object.freeze([
  {
    id: "landowner_jv",
    evidenceRefs: ["MB-F57", "MB-F59", "MB-T5"],
    pattern: /(?:\b(?:i|we)\s+(?:own|hold)\s+(?:(?:the|a|my|our)\s+)?(?:land|plot)\b.{0,120}\b(?:joint\s+venture|joint\s+development|partner(?:ship)?|developer|develop|development)\b|\blandowner\b.{0,100}\b(?:joint\s+venture|joint\s+development|partner(?:ship)?|developer)\b|\bjoint\s+venture\b.{0,100}\b(?:land|plot)\b|(?:أملك|عندي|نملك|لدينا).{0,100}(?:أرض|ارض).{0,100}(?:شراكة|شارك|مطوّر|مطور|مشروع مشترك|تطوير|طور)|مالك أرض.{0,80}(?:شراكة|مشروع مشترك|تطوير مشترك)|(?:ιδιοκτήτης|έχω|έχουμε).{0,80}(?:γη|οικόπεδο).{0,100}(?:κοινή ανάπτυξη|κοινοπραξία|συνεργασία|ανάπτυξη))/iu
  },
  {
    id: "construction_tender",
    evidenceRefs: ["MB-F60", "MB-F61", "MB-F62", "MB-T5"],
    pattern: /\b(?:construction\s+tender|tender\s+(?:for\s+)?(?:construction|building)|(?:construction|building)\s+tender|bill\s+of\s+quantities|boq)\b|\b(?:we\s+)?(?:have|received|are\s+issuing)\s+(?:a\s+)?(?:construction|building)\s+tender\b|مناقصة\s*(?:إنشاء|بناء|عقارية)?|جدول\s+الكميات|κατασκευαστικ(?:ός|ή|ό)\s+διαγωνισμ(?:ός|ό|ο)|διαγωνισμ(?:ός|ό|ο)\s+κατασκευ/iu
  },
  {
    id: "hnw_budget_1m_plus",
    evidenceRefs: ["MB-F56", "MB-T5"],
    matches: matchesMillionPlus
  },
  {
    id: "international_partnership",
    evidenceRefs: ["MB-T5"],
    pattern: /\b(?:international|cross[- ]border|overseas|foreign)\s+(?:strategic\s+)?partnership\b|\bpartnership\b.{0,70}\b(?:international|cross[- ]border|overseas|foreign)\b|\bpartner(?:ship)?\s+(?:with|between)\s+(?:a\s+)?(?:company|firm)\s+(?:in\s+)?(?:another\s+country|abroad)\b|شراكة\s+(?:دولية|عابرة\s+للحدود)|تعاون\s+دولي|διεθν(?:ής|ή)\s+συνεργασία|διασυνοριακή\s+συνεργασία/iu
  }
]);

function amountAtLeastOneMillion(value, suffix = "") {
  const raw = String(value)
    .replace(/[٠-٩۰-۹]/g, digit => String(digit.codePointAt(0) <= 0x0669
      ? digit.codePointAt(0) - 0x0660
      : digit.codePointAt(0) - 0x06f0))
    .replace(/٬/g, ",")
    .replace(/٫/g, ".");
  const numeric = /[,\.]\d{3}(?:[,\.]\d{3})+$/.test(raw)
    ? raw.replace(/[,\.]/g, "")
    : /[,\.]\d{3}$/.test(raw) && /(?:m|mn|million)/iu.test(suffix)
      ? raw.replace(/[,\.]/g, "")
      : raw.replace(",", ".");
  const amount = Number(numeric);
  return Number.isFinite(amount) && (/(?:m|mn|million|مليون)/iu.test(suffix) ? amount >= 1 : amount >= 1_000_000);
}

function matchesMillionPlus(text) {
  const value = String(text || "");
  const digit = "[0-9٠-٩۰-۹]";
  const separator = "[,.٬٫]";
  const number = `(${digit}{1,3}(?:${separator}${digit}{3})+|${digit}+(?:${separator}${digit}+)?)`;
  const currencyFirst = new RegExp(`(?:€|\\b(?:eur|euros?)\\b)\\s*${number}\\s*(m|mn|million)?`, "giu");
  const amountFirst = new RegExp(`(?<![0-9A-Za-z])${number}\\s*(m|mn|million|مليون)\\s*(?:euros?|eur|€|يورو)?`, "giu");
  const amountBeforeCurrency = new RegExp(`(?<![0-9A-Za-z])${number}\\s*(m|mn|million|مليون)?\\s*(?:euros?|eur|€|يورو)`, "giu");
  for (const match of value.matchAll(currencyFirst)) if (amountAtLeastOneMillion(match[1], match[2]) && !isNegated(value, match.index)) return true;
  for (const match of value.matchAll(amountFirst)) if (amountAtLeastOneMillion(match[1], match[2]) && !isNegated(value, match.index)) return true;
  for (const match of value.matchAll(amountBeforeCurrency)) if (amountAtLeastOneMillion(match[1], match[2]) && !isNegated(value, match.index)) return true;
  const localized = /(?:أكثر\s+من|فوق|لا\s+يقل\s+عن).{0,25}مليون\s*(?:يورو|€)|(?:ميزانية|استثمار)(?:(?![0-9٠-٩۰-۹]).){0,30}مليون\s*(?:يورو|€)|(?:πάνω|άνω)\s+από\s+1\s*(?:εκατομμύριο|εκ\.?)\s*(?:ευρώ|€)?|(?:προϋπολογισμός|επένδυση).{0,30}(?:1\s*(?:εκατομμύριο|εκ\.?)|€\s*1\s*(?:m|εκ\.?))/giu;
  for (const match of value.matchAll(localized)) if (!isNegated(value, match.index)) return true;
  return false;
}

function isNegated(text, index) {
  const before = text.slice(Math.max(0, index - 70), index);
  const clause = before.slice(Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf(";"), before.lastIndexOf(","), before.lastIndexOf("\n"), before.toLowerCase().lastIndexOf(" but "), before.toLowerCase().lastIndexOf(" yet "), before.lastIndexOf("لكن"), before.lastIndexOf("ولكن"), before.lastIndexOf(" بس"), before.lastIndexOf(" بل"), before.lastIndexOf("αλλά"), before.lastIndexOf("όμως")) + 1);
  return /(?:\b(?:no|not|never|neither|without|don't|do not|doesn't|does not|didn't|did not|isn't|is not|aren't|are not|wasn't|was not|weren't|were not|haven't|have not|hasn't|has not|can't|cannot|won't|will not)\b|(?<![\p{L}\p{N}])(?:لا\s+(?:يوجد|توجد|لدينا|نملك|أملك|أمتلك)|ليس|ليست|ما|مش|مو)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:δεν|μην|μη|όχι)(?![\p{L}\p{N}]))/iu.test(clause);
}

/**
 * Identify P6.6 strategic opportunities and return safe internal routing
 * metadata. The source message is not included in the result.
 *
 * @param {string|{text?: string, message?: string}} input
 * @returns {null|{classId: string, priority: string, escalation: string, route: string, evidenceRefs: string[], constructionPricing: string|null}}
 */
function detectStrategicEscalation(input) {
  const text = typeof input === "string" ? input : input?.text ?? input?.message;
  if (typeof text !== "string" || !text.trim()) return null;
  for (const entry of CLASSES) {
    if (entry.matches ? !entry.matches(text) : (() => {
      const pattern = new RegExp(entry.pattern.source, `${entry.pattern.flags.replace("g", "")}g`);
      for (const match of text.matchAll(pattern)) if (!isNegated(text, match.index)) return false;
      return true;
    })()) continue;
    return Object.freeze({
      classId: entry.id,
      priority: "urgent",
      escalation: "senior_consultant",
      route: ROUTE,
      evidenceRefs: Object.freeze([...entry.evidenceRefs]),
      constructionPricing: entry.id === "construction_tender" ? "prohibited" : null
    });
  }
  return null;
}

module.exports = { detectStrategicEscalation, matchesMillionPlus };
