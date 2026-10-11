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

function normalizeForComparison(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function extractLiteralEvidence(message, value) {
  const source = String(message || "").trim();
  const target = normalizeForComparison(value);
  if (!source || !target) return "";
  // Deliberately require a full literal phrase after Unicode/case/spacing
  // normalization. This avoids treating a partial token (for example "2"
  // inside a phone number) as support for a CRM value.
  const words = target.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${words.join("\\s+")}(?=$|[^\\p{L}\\p{N}])`, "iu");
  const normalized = source.normalize("NFKC").toLocaleLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
  const match = pattern.exec(normalized);
  if (!match) return "";
  // Keep the original turn as provenance. Do not manufacture a quoted span
  // from normalized text, which may differ from the customer's spelling.
  return source.slice(0, 500);
}

function isNegatedLiteralMention(message, value) {
  const source = String(message || "").normalize("NFKC").toLocaleLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
  const target = normalizeForComparison(value);
  if (!source || !target) return false;
  const escaped = target.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+");
  const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").exec(source);
  if (!match) return false;
  const prefix = source.slice(0, match.index).slice(-90);
  const words = prefix.split(/\s+/u).filter(Boolean);
  const suffix = words.slice(-7).join(" ");
  if (/(?:^|\s)(?:not|don t|do not|never|no longer|without)(?:\s+[\p{L}\p{N}]+){0,5}$/iu.test(suffix)) return true;
  for (let index = Math.max(0, words.length - 7); index < words.length; index += 1) {
    if (["لا", "ليس", "ليست", "ما", "δεν", "όχι", "μην"].includes(words[index]) && words.length - index <= 6) return true;
  }
  return false;
}

function isSelfIdentifiedName(message, name) {
  const source = String(message || "");
  const literal = extractLiteralEvidence(source, name);
  if (!literal) return false;
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const normalizedName = escapedName.replace(/\s+/gu, "\\s+");
  const patterns = [
    new RegExp(`\\b(?:my name is|i am|i'm|this is)\\s+${normalizedName}(?=$|[^\\p{L}])`, "iu"),
    new RegExp(`(?:اسمي|أنا اسمي|انا اسمي|أنا|انا)\\s*${normalizedName}(?=$|[^\\p{L}])`, "iu"),
    new RegExp(`(?:με λένε|ονομάζομαι|είμαι)\\s+${normalizedName}(?=$|[^\\p{L}])`, "iu")
  ];
  return patterns.some((pattern) => pattern.test(source));
}

function isExplicitCorrectionMessage(message) {
  return /\b(?:actually|correction|to correct that|i meant|i should say|instead)\b|(?:قصدي|تصحيح|أقصد|اقصد|للتصحيح)|(?:^|[^\p{L}\p{N}])(?:διόρθωση|εννοούσα|για να διορθώσω)(?=$|[^\p{L}\p{N}])/iu.test(String(message || ""));
}

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

module.exports = { CRM_FIELDS, CUSTOMER_PROVENANCE, DERIVED_PROVENANCE, normalizeForComparison, extractLiteralEvidence, isNegatedLiteralMention, isSelfIdentifiedName, isExplicitCorrectionMessage, normalizeCrmCandidate, mergeCrmCandidate };
