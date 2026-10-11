export const CRM_PROFILE_GROUPS = Object.freeze({
  name: "identity_fields", phone: "identity_fields", email: "identity_fields", preferredLanguage: "identity_fields",
  nationality: "identity_fields", countryOfResidence: "identity_fields",
  primaryIntent: "opportunity_fields", targetService: "opportunity_fields", businessActivity: "opportunity_fields",
  businessStatus: "opportunity_fields", targetMarkets: "opportunity_fields", bankingNeed: "opportunity_fields",
  residencyInterest: "property_residency_fields", investmentBudget: "property_residency_fields", preferredCity: "property_residency_fields",
  propertyPurpose: "property_residency_fields", familyMembers: "property_residency_fields", sourceOfFundsStatus: "property_residency_fields",
  sourceOfWealthOverview: "property_residency_fields",
  timeline: "qualification_fields", mainMotivation: "qualification_fields", mainObjection: "qualification_fields",
  decisionAuthority: "qualification_fields", leadScore: "qualification_fields", leadTier: "qualification_fields",
  nextAction: "qualification_fields", appointmentStatus: "qualification_fields"
});

const COMPARABLE_FIELDS = new Set(["investmentBudget", "familyMembers", "leadScore"]);

function normalized(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

export function validateCrmValueAgainstMessage(field, value, message) {
  if (!Object.hasOwn(CRM_PROFILE_GROUPS, field)) return false;
  if (typeof value !== "string" || !value.trim() || value.length > 500) return false;
  // The Node CRM normalizer intentionally masks contact identifiers before
  // the authenticated write. Verify these masked candidates against the
  // labeled value in the original, contact-owned turn.
  if (field === "email" && value === "[email]" && /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(String(message || ""))) return true;
  if (field === "phone" && value === "[phone]" && /(?:\+?\d[\d\s().-]{7,}\d)/u.test(String(message || ""))) return true;
  const source = normalized(message);
  const target = normalized(value);
  if (!source || !target || !new RegExp(`(?:^| )${target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$| )`, "u").test(source)) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const occurrence = source.search(new RegExp(`(?:^| )${escaped}(?=$| )`, "u"));
  const match = source.match(new RegExp(`(?:^| )${escaped}(?=$| )`, "u"));
  const prefix = occurrence < 0 ? "" : source.slice(0, occurrence).split(/\s+/u).slice(-7).join(" ");
  const suffix = occurrence < 0 ? "" : source.slice(occurrence + (match?.[0]?.length || 0)).trim().split(/\s+/u).slice(0, 7).join(" ");
  if (/(?:^| )(?:not|don t|do not|never|no longer|without)(?: [\p{L}\p{N}]+){0,5}$/iu.test(prefix)) return false;
  if (/(?:^| )(?:لا|ليس|ليست|ما|δεν|όχι|μην)(?: [\p{L}\p{N}]+){0,5}$/iu.test(prefix)) return false;
  if (/^(?:(?:but|however|although) )?(?:(?:is|was|would be|will be|am|are|want|wanted|need|needed|choose|chose|prefer|preferred|looking for) )?(?:not|never|no longer|without|i (?:do not|don t|never) (?:want|need|prefer)|what i (?:do not|don t|never) (?:want|need|prefer)|not what i (?:want|need|prefer))(?: |$)/iu.test(suffix)) return false;
  if (/^(?:لا|ليس|ليست|ما|مش|مو)(?: (?:أنا|انا|هو|هي|هذا|هذه|أريد|اريد|أحتاج|احتاج|أفضل|افضل|أبغى|ابغى)){0,2}(?: |$)/u.test(suffix)) return false;
  if (/^(?:δεν|όχι|μην)(?: (?:το|την|τον|θέλω|χρειάζομαι|προτιμώ)){0,3}(?: |$)/u.test(suffix)) return false;
  // Numeric values may be safely normalized (e.g. "€50,000" -> "50000");
  // ordinary strings must remain literal evidence from the current turn.
  if (COMPARABLE_FIELDS.has(field) && /^\d+(?:[.,]\d+)?$/u.test(target)) {
    const digits = target.replace(/[.,]/gu, "");
    return source.replace(/[.,]/gu, "").includes(digits);
  }
  return true;
}

export function isExplicitCrmCorrection(message) {
  return /\b(?:actually|correction|to correct that|i meant|i should say|instead)\b|(?:قصدي|تصحيح|أقصد|اقصد|للتصحيح)|(?:^|[^\p{L}\p{N}])(?:διόρθωση|εννοούσα|για να διορθώσω)(?=$|[^\p{L}\p{N}])/iu.test(String(message || ""));
}

export function isSelfIdentifiedCrmName(message, value) {
  const escaped = normalized(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!escaped) return false;
  const patterns = [
    new RegExp(`(?:^| )(?:my name is|i am|i m|this is) ${escaped}(?=$| )`, "iu"),
    new RegExp(`(?:^| )(?:اسمي|أنا اسمي|انا اسمي|أنا|انا) ${escaped}(?=$| )`, "iu"),
    new RegExp(`(?:^| )(?:με λένε|ονομάζομαι|είμαι) ${escaped}(?=$| )`, "iu")
  ];
  const source = normalized(message);
  return patterns.some((pattern) => pattern.test(source));
}

export function crmRowToAgentFacts(row) {
  const facts = {};
  if (!row || typeof row !== "object") return { agentFacts: facts, crmCorrectionNeeded: null };
  for (const [field, group] of Object.entries(CRM_PROFILE_GROUPS)) {
    const value = row[group]?.[field];
    if (value === undefined || value === null || typeof value === "object") continue;
    const provenance = row.field_provenance?.[field] || {};
    facts[field.toLowerCase()] = {
      value: String(value), normalizedValue: String(value), provenance: "customer_message", confidence: 1,
      sourceTurnId: provenance.source_turn_id || null, savedAt: provenance.captured_at || null, durable: true
    };
  }
  const marker = row.crm_correction_needed;
  return {
    hasRow: Boolean(row),
    agentFacts: facts,
    crmCorrectionNeeded: marker?.field ? { field: String(marker.field).toLowerCase().slice(0, 64) } : null
  };
}

export function mergeCrmProfileRow(current, { field, value, sourceTurnId, capturedAt, correction = false }) {
  const group = CRM_PROFILE_GROUPS[field];
  if (!group) throw new Error("Unsupported CRM field.");
  const row = current || {};
  const grouped = { ...(row[group] || {}) };
  const previous = grouped[field];
  const provenance = { ...(row.field_provenance || {}) };
  if (previous !== undefined && normalized(previous) !== normalized(value) && !correction) {
    return {
      ...row,
      crm_correction_needed: { field, source_turn_id: sourceTurnId, recorded_at: capturedAt },
      source_turn_id: sourceTurnId,
      conflict: true
    };
  }
  grouped[field] = value;
  provenance[field] = { source: "customer_message", source_turn_id: sourceTurnId, captured_at: capturedAt };
  return {
    ...(row || {}), contact_id: row?.contact_id,
    [group]: grouped, field_provenance: provenance, crm_correction_needed: {}, source_turn_id: sourceTurnId,
    conflict: false
  };
}
