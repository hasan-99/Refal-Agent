import { isPlausibleCustomerName } from "./contactIdentity.js";

function recentConversations(users, limit = 5) {
  return users.flatMap((user) => (user.history || []).map((turn, index) => {
    const preview = String(turn.message || "").replace(/\s+/g, " ").trim();
    const at = turn.at || "";
    const name = String(
      user.profile?.nameOverride ||
      (isPlausibleCustomerName(user.profile?.name) ? user.profile.name : "") ||
      user.whatsapp?.pushName ||
      user.profile?.whatsappName ||
      "WhatsApp contact"
    ).trim();

    return {
      id: `${user.id || "contact"}:${index}:${at}`,
      name: name || "WhatsApp contact",
      preview: preview.slice(0, 180),
      at
    };
  }))
    .filter((turn) => turn.preview && Number.isFinite(Date.parse(turn.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

function contactActivityStats(users, now = new Date()) {
  const recentStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return users.reduce((stats, user) => {
    const history = user.history || [];
    stats.contacts += 1;
    stats.conversationTurns += history.length;
    if (history.length) stats.contactsWithConversations += 1;
    if (history.some((turn) => {
      const at = Date.parse(turn.at || "");
      return Number.isFinite(at) && at >= recentStart && at <= now.getTime();
    })) stats.activeLast7Days += 1;
    return stats;
  }, { contacts: 0, contactsWithConversations: 0, activeLast7Days: 0, conversationTurns: 0 });
}

const QUALIFICATION_DIMENSIONS = Object.freeze(["need", "value", "timing", "authority", "readiness", "fit"]);
const CONSENT_STATES = new Set(["unknown", "granted", "denied", "revoked"]);
const INTENT_VALUES = new Set([
  "greeting", "small_talk", "company_info", "services", "contact", "real_estate", "land_development",
  "construction", "corporate_services", "investment", "partnership", "appointment", "existing_client",
  "complaint", "legal", "tax", "immigration", "banking", "permit", "approval", "privacy", "unknown"
]);

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function cleanOperatorText(value, limit = 280) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:password|passcode|pin|token|api[_ -]?key|secret|cvv)\s*[:=]?\s*\S+/giu, "[redacted]")
    .trim()
    .slice(0, limit);
}

function cleanHandoverSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return cleanOperatorText(value, 700);
  const fields = [
    ["Need", value.need],
    ["Opportunity", value.opportunity],
    ["Activity", value.project],
    ["Next step", value.nextAction]
  ];
  return fields
    .filter(([, field]) => field !== undefined && field !== null && String(field).trim())
    .map(([label, field]) => `${label}: ${cleanOperatorText(field, 180)}`)
    .join(" · ")
    .slice(0, 700);
}

function normalizeIntent(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return INTENT_VALUES.has(normalized) ? normalized : "unknown";
}

function operatorSignals(user) {
  const profile = user?.profile || {};
  const qualification = profile.qualification || profile.leadQualification || {};
  const classification = profile.classification || profile.workflowClassification || {};
  const intent = profile.intent || profile.detectedIntent || classification.intent || {};
  const handover = profile.handover || profile.handoverSummary || {};
  const dimensionsSource = qualification.dimensions || classification.dimensions || profile.dimensions || {};
  const dimensions = Object.fromEntries(QUALIFICATION_DIMENSIONS.map((key) => {
    const number = Number(dimensionsSource[key]);
    return [key, Number.isFinite(number) ? Math.max(0, Math.min(5, Math.round(number))) : null];
  }));
  const rawIntents = firstValue(intent.intents, classification.intents, profile.intents, intent.primary, classification.primary, profile.intent);
  const intents = (Array.isArray(rawIntents) ? rawIntents : [rawIntents]).map(normalizeIntent).filter((value, index, list) => value !== "unknown" || list.length === 1 ? list.indexOf(value) === index : false);
  const primaryIntent = normalizeIntent(firstValue(intent.primary, classification.primary, profile.primaryIntent, intents[0]));
  const consent = firstValue(profile.consent?.followUp, profile.followUpConsent, profile.follow_up_consent);
  const consentState = CONSENT_STATES.has(String(consent)) ? String(consent) : "unknown";
  const lastFollowUpSent = firstValue(user.lastFollowUpSent, profile.lastFollowUpSent, profile.followUp?.lastSent);
  const rawHandoverSummary = firstValue(handover.summary, handover.internalSummary, profile.internalHandoverSummary);
  const handoverSummary = cleanHandoverSummary(rawHandoverSummary);
  const department = cleanOperatorText(firstValue(handover.department, handover.routing?.department, classification.department), 80);
  const nextAction = cleanOperatorText(firstValue(handover.nextAction, handover.followUpAction, profile.nextAction), 180);

  return {
    intent: primaryIntent,
    intents: intents.filter((value) => value !== "unknown"),
    classification: cleanOperatorText(firstValue(classification.label, classification.category, qualification.status, profile.classificationLabel), 80) || "unclassified",
    priority: ["urgent", "high", "normal"].includes(String(firstValue(handover.priority, profile.priority, qualification.priority))) ? String(firstValue(handover.priority, profile.priority, qualification.priority)) : "normal",
    dimensions,
    consent: { followUp: consentState, updatedAt: profile.consent?.followUpUpdatedAt || profile.followUpConsentUpdatedAt || null },
    followUp: { status: user.blocked || profile.followUpBlocked ? "blocked" : lastFollowUpSent ? "sent" : consentState === "granted" ? "eligible" : "consent_required", lastSentAt: lastFollowUpSent || null },
    handover: { required: Boolean(handover.required || handover.handoverRequired || profile.handoverRequired), department: department || "general", summary: handoverSummary, nextAction },
    flags: { complaint: Boolean(profile.isComplaint || profile.complaint || classification.complaint || primaryIntent === "complaint"), existingClient: Boolean(profile.existingClient || profile.isExistingClient || classification.existingClient || primaryIntent === "existing_client") }
  };
}

export { contactActivityStats, recentConversations, operatorSignals, QUALIFICATION_DIMENSIONS };
