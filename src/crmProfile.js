// P8.2 CRM extraction contract. Model-produced candidates are untrusted:
// this module only accepts allow-listed fields plus source-turn evidence and
// explicit provenance. It never treats a candidate as company knowledge.

const { redactSensitiveData } = require("./sensitiveData");
const { redactPersonalData } = require("./ai.js");

const CRM_FIELDS = Object.freeze({
  name: "identity", phone: "identity", email: "identity", preferredLanguage: "identity",
  nationality: "identity", countryOfResidence: "identity",
  primaryIntent: "opportunity", targetService: "opportunity", businessActivity: "opportunity",
  businessStatus: "opportunity", targetMarkets: "opportunity", bankingNeed: "opportunity",
  residencyInterest: "property_residency", investmentBudget: "property_residency",
  preferredCity: "property_residency", propertyPurpose: "property_residency",
  familyMembers: "property_residency", sourceOfFundsStatus: "property_residency",
  sourceOfWealthOverview: "property_residency",
  timeline: "qualification", mainMotivation: "qualification", mainObjection: "qualification",
  decisionAuthority: "qualification", leadScore: "qualification", leadTier: "qualification",
  nextAction: "qualification", appointmentStatus: "qualification"
});

const CUSTOMER_PROVENANCE = "customer_message";
const DERIVED_PROVENANCE = "derived_from_customer_message";

function normalizeCrmCandidate(candidate = {}) {
  const field = String(candidate.field || "");
  const value = candidate.normalizedValue ?? candidate.value;
  const rawValue = candidate.rawValue ?? candidate.value;
  const provenance = candidate.provenance;
  const confidence = Number(candidate.confidence);
  const redact = (text) => redactSensitiveData(redactPersonalData(text));
  const evidence = redact(String(candidate.evidence || "").trim()).slice(0, 500);
  const sourceTurnId = String(candidate.sourceTurnId || "").trim();
  if (!Object.hasOwn(CRM_FIELDS, field)) return { ok: false, reason: "unknown_field" };
  if (field === "name" && candidate.selfIdentified !== true) return { ok: false, reason: "name_not_self_identified" };
  if (![CUSTOMER_PROVENANCE, DERIVED_PROVENANCE].includes(provenance)) return { ok: false, reason: "invalid_provenance" };
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, reason: "invalid_confidence" };
  if (!evidence || evidence.length > 500 || !sourceTurnId || sourceTurnId.length > 160) return { ok: false, reason: "missing_provenance" };
  if (typeof value !== "string" || !value.trim() || value.length > 500 || typeof rawValue !== "string" || !rawValue.trim() || rawValue.length > 500) {
    return { ok: false, reason: "invalid_value" };
  }
  // Inference is retained as inference, but never promoted into the
  // customer-stated record used by never-reask.
  return {
    ok: true,
    record: Object.freeze({
      rawValue: redact(rawValue.trim()).slice(0, 500), normalizedValue: redact(value.trim()).slice(0, 500), provenance,
      confidence, sourceTurnId, evidence, inferred: provenance === DERIVED_PROVENANCE,
      group: CRM_FIELDS[field]
    })
  };
}

function mergeCrmCandidate(existing = {}, candidate) {
  const normalized = normalizeCrmCandidate(candidate);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  const current = existing[candidate.field];
  const next = normalized.record;
  if (!current) return { ok: true, record: next, correctionNeeded: false };
  const currentValue = String(current.normalizedValue ?? current.value ?? "").trim().toLocaleLowerCase();
  if (currentValue === next.normalizedValue.toLocaleLowerCase()) {
    return { ok: true, record: current, correctionNeeded: false, unchanged: true };
  }
  // Conflicts must be reviewed or clarified; never silently replace the
  // customer's earlier value. Do not persist either value as a new fact here.
  return {
    ok: true,
    record: current,
    correctionNeeded: true,
    correction: Object.freeze({ field: candidate.field, priorValue: currentValue, proposedValue: next.normalizedValue, sourceTurnId: next.sourceTurnId })
  };
}

module.exports = { CRM_FIELDS, CUSTOMER_PROVENANCE, DERIVED_PROVENANCE, normalizeCrmCandidate, mergeCrmCandidate };
