const { detectMessageLanguage, foldRulePatterns, localizedLanguage } = require("./language");
const { HUMOUR_LEVELS } = require("./humourEngine");
const { COMPLIANCE_FLAGS, assessRedFlags, normalizeRedFlagText } = require("./redFlagRules");

// P2.5 / W2.5.2 + W2.5.3 — compliance escalation (MB-SEC2).
//
// A compliance escalation is NOT a sales handover. It is a regulatory
// obligation, so it does NOT require customer consent, and it is the one
// documented exception to the "handover only after explicit consent" rule in the
// Anti Regression Checklist (plan 0.2).
//
// Four things it must never do (MB-SEC2, CX 12B):
//   1. Debate or argue with the evasion attempt. No "that would be illegal",
//      no counter-argument, no lecture. The file moves, the conversation does
//      not turn into a negotiation.
//   2. Explain how to avoid detection. Saying what would have been acceptable
//      is itself a roadmap.
//   3. Reveal an internal score, label, rule name or flag id to the customer.
//   4. Announce the internal record beyond the sober acknowledgment.
//
// W2.5.3 — once it fires it is STICKY. Humour goes to 0 and every sales hook is
// suppressed for the rest of the conversation, not just the triggering turn.
// The humour level is the same representation humourEngine uses, a number from
// HUMOUR_LEVELS, so there is exactly one notion of "level 0" in the repo.
//
// REGEX WARNING: \b is ASCII-only in JavaScript even under /u, so no non-Latin
// alternative below is \b-wrapped, and no Greek stem uses `\w`.

// AML terms that are an escalation in their own right, independent of the
// red-flag table. These are the named MB-SEC2 triggers: a sanctioned party, and
// laundering or terrorist financing stated outright.
const rawAmlRules = [
  ["sanctioned_party", /\b(?:sanctioned (?:person|individual|entity|compan(?:y|ies)|bank|party|country|jurisdiction|supplier)|on the sanctions list|sanctions list|sdn list|ofac list|designated person|asset freeze|frozen by sanctions)\b|(?:شخص خاضع للعقوبات|جهة خاضعة للعقوبات|شركة خاضعة للعقوبات|على قائمة العقوبات|قائمة المحظورين|مدرج على العقوبات)|(?:υπό κυρώσεις|στη λίστα κυρώσεων|λίστα κυρώσεων|κατονομαζόμενο πρόσωπο|δέσμευση περιουσιακών στοιχείων)/iu],
  ["money_laundering", /\b(?:money launder(?:ing|ed|er|ers)?|launder(?:ing)? (?:the )?(?:money|funds|cash)|wash(?:ing)? (?:the )?money|clean(?:ing)? (?:the )?dirty money|dirty money)\b|(?:غسل الأموال|غسيل الأموال|تبييض الأموال|أموال قذرة|أموال غير مشروعة)|(?:ξέπλυμα (?:χρήματος|βρώμικου χρήματος|μαύρου χρήματος)|ξεπλύν[\p{L}]*|βρώμικο χρήμα|μαύρο χρήμα)/iu],
  ["terrorist_financing", /\b(?:terrorist financing|terrorism financing|financing (?:of )?terrorism|finance terrorism)\b|(?:تمويل الإرهاب|تمويل إرهابي)|(?:χρηματοδότηση (?:της )?τρομοκρατίας|τρομοκρατική χρηματοδότηση)/iu]
];

const amlRules = foldRulePatterns(rawAmlRules);

// Sober acknowledgment. Authored natively per language, not translated.
// Deliberately contains: no judgment, no counter-argument, no mention of what
// triggered it, no rule name, no score, no advice. It states the limit, names
// the responsible team, and keeps a door open for ordinary questions.
const CUSTOMER_MESSAGES = Object.freeze({
  english: "I am not able to help with this request. Requests of this kind are handled by our compliance team under the rules we are required to follow, and your message has been passed to them. I can still help with general information about our services.",
  arabic: "ما فيني ساعدك بهالطلب. هالنوع من الطلبات بيتعامل معه فريق الامتثال عنا حسب القواعد اللي لازم نلتزم فيها، وتم تحويل رسالتك إلهم. فيني ساعدك بمعلومات عامة عن خدماتنا.",
  greek: "Δεν μπορώ να βοηθήσω με αυτό το αίτημα. Αιτήματα αυτού του είδους τα χειρίζεται η ομάδα συμμόρφωσης, σύμφωνα με τους κανόνες που οφείλουμε να τηρούμε, και το μήνυμά σας προωθήθηκε σε αυτούς. Μπορώ να βοηθήσω με γενικές πληροφορίες για τις υπηρεσίες μας."
});

function normalizeTriggers(redFlags) {
  if (!redFlags) return [];
  if (Array.isArray(redFlags)) return redFlags.map((flag) => String(flag));
  if (Array.isArray(redFlags.complianceFlags)) return redFlags.complianceFlags.map((flag) => String(flag));
  if (Array.isArray(redFlags.flags)) return redFlags.flags.map((flag) => String(flag));
  return [];
}

/**
 * W2.5.2 — is this turn a compliance escalation?
 *
 * Triggers come from three places and are unioned: compliance flags the caller
 * already computed, compliance flags found in this text, and the AML terms
 * above. Trigger ids are INTERNAL. They go in the record, never in a reply.
 */
function detectComplianceEscalation(text, { redFlags = [] } = {}) {
  const value = normalizeRedFlagText(text);
  const fromCaller = normalizeTriggers(redFlags).filter((flag) => COMPLIANCE_FLAGS.includes(flag));
  const fromText = value ? assessRedFlags(text).complianceFlags : [];
  const fromAml = value ? amlRules.filter(([, pattern]) => pattern.test(value)).map(([id]) => id) : [];
  const triggers = [...new Set([...fromCaller, ...fromText, ...fromAml])].sort();
  return { escalate: triggers.length > 0, triggers, language: detectMessageLanguage(text) };
}

/**
 * W2.5.2 / W2.5.3 — build the escalation.
 *
 * Returns null when there is nothing to escalate, so a caller can use it as a
 * plain guard. `triggers` may be passed in when the caller has already run
 * detectComplianceEscalation with the turn's red flags; otherwise it is derived
 * from the text.
 */
function buildComplianceEscalation(text, { language, conversationId, redFlags = [], triggers } = {}) {
  const supplied = Array.isArray(triggers) ? triggers.filter((flag) => typeof flag === "string" && flag) : [];
  const detection = detectComplianceEscalation(text, { redFlags });
  const resolved = supplied.length ? [...new Set([...supplied, ...detection.triggers])].sort() : detection.triggers;
  if (!resolved.length) return null;

  const resolvedLanguage = CUSTOMER_MESSAGES[language] ? language : detection.language;

  return {
    customerMessage: localizedLanguage(resolvedLanguage, CUSTOMER_MESSAGES),
    internalRecord: Object.freeze({
      kind: "compliance_escalation",
      triggers: Object.freeze([...resolved]),
      language: resolvedLanguage,
      createdAt: new Date().toISOString(),
      conversationId: conversationId === undefined ? null : conversationId
    }),
    // Regulatory obligation, not marketing. Consent is irrelevant here and
    // asking for it would itself be a debate with the request.
    requiresConsent: false,
    humourLevel: HUMOUR_LEVELS.SERIOUS,
    suppressSalesHooks: true
  };
}

/**
 * W2.5.3 — the sticky lock.
 *
 * Pure: returns a new state object and never mutates the one passed in. Once
 * locked, a later turn with no escalation cannot unlock it; only an explicit
 * reset elsewhere in the system could, and nothing in this module offers one.
 */
function applyComplianceLock(conversationState = {}, escalation = null) {
  const base = { ...(conversationState && typeof conversationState === "object" ? conversationState : {}) };
  const alreadyLocked = isComplianceLocked(base);
  if (!escalation && !alreadyLocked) return base;

  const previous = Array.isArray(base.complianceTriggers) ? base.complianceTriggers : [];
  const incoming = escalation && escalation.internalRecord && Array.isArray(escalation.internalRecord.triggers)
    ? escalation.internalRecord.triggers
    : [];

  return {
    ...base,
    complianceLocked: true,
    humourLevel: HUMOUR_LEVELS.SERIOUS,
    salesHooksSuppressed: true,
    complianceTriggers: [...new Set([...previous, ...incoming])].sort()
  };
}

function isComplianceLocked(conversationState) {
  return Boolean(conversationState && conversationState.complianceLocked === true);
}

module.exports = {
  CUSTOMER_MESSAGES,
  detectComplianceEscalation,
  buildComplianceEscalation,
  applyComplianceLock,
  isComplianceLocked
};
