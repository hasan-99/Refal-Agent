const { assessPriority } = require("./priorityRules");
const { redactSensitiveData } = require("./sensitiveData");

const DEPARTMENTS = Object.freeze({
  customer_service: "customer_service",
  corporate_services: "corporate_services",
  real_estate: "real_estate",
  development_construction: "development_construction",
  investment: "investment",
  partnerships: "partnerships",
  complaints: "complaints",
  existing_client: "existing_client",
  appointments: "appointments",
  general: "general"
});

const INTENT_ROUTES = Object.freeze({
  complaint: DEPARTMENTS.complaints,
  existing_client: DEPARTMENTS.existing_client,
  company_formation: DEPARTMENTS.corporate_services,
  accounting: DEPARTMENTS.corporate_services,
  vat: DEPARTMENTS.corporate_services,
  cyprus_business_expansion: DEPARTMENTS.corporate_services,
  business_relocation: DEPARTMENTS.corporate_services,
  residency_enquiry: DEPARTMENTS.corporate_services,
  real_estate_purchase: DEPARTMENTS.real_estate,
  real_estate_investment: DEPARTMENTS.investment,
  property_development: DEPARTMENTS.development_construction,
  construction_tender: DEPARTMENTS.development_construction,
  project_management: DEPARTMENTS.development_construction,
  investment_opportunity: DEPARTMENTS.investment,
  investment_partnership: DEPARTMENTS.partnerships,
  strategic_partnership: DEPARTMENTS.partnerships,
  infrastructure: DEPARTMENTS.development_construction,
  technology: DEPARTMENTS.corporate_services,
  operations: DEPARTMENTS.corporate_services,
  strategic_assets: DEPARTMENTS.investment,
  business_proposal: DEPARTMENTS.corporate_services,
  supplier: DEPARTMENTS.corporate_services,
  career: DEPARTMENTS.general,
  media: DEPARTMENTS.general,
  general_information: DEPARTMENTS.general,
  company_info: DEPARTMENTS.general,
  services: DEPARTMENTS.general,
  contact: DEPARTMENTS.general,
  legal: DEPARTMENTS.corporate_services,
  tax: DEPARTMENTS.corporate_services,
  immigration: DEPARTMENTS.corporate_services,
  banking: DEPARTMENTS.corporate_services,
  permit: DEPARTMENTS.development_construction,
  approval: DEPARTMENTS.corporate_services,
  development: DEPARTMENTS.development_construction,
  construction: DEPARTMENTS.development_construction,
  land: DEPARTMENTS.development_construction,
  real_estate: DEPARTMENTS.real_estate,
  corporate_services: DEPARTMENTS.corporate_services,
  investment: DEPARTMENTS.investment,
  partnership: DEPARTMENTS.partnerships,
  appointment: DEPARTMENTS.appointments,
  customer_service: DEPARTMENTS.customer_service,
  general: DEPARTMENTS.general
});

const PRIORITY_INTENTS = new Set(["complaint", "existing_client", "development", "construction", "land", "infrastructure", "strategic_assets", "investment", "partnership", "property_development", "construction_tender", "investment_opportunity", "investment_partnership", "strategic_partnership", "land_owner"]);
const MAX_FIELD_LENGTH = 500;

function clean(value, max = MAX_FIELD_LENGTH) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeValue(value, max = MAX_FIELD_LENGTH) {
  return redactSensitiveData(clean(value, max))
    .replace(/(?:password|passcode|pin|token|api[_ -]?key|secret|cvv)\s*[:=]?\s*\S+/giu, "[redacted]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/giu, "[email withheld]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone withheld]");
}

function plausibleCustomerName(value) {
  const name = clean(value, 120);
  if (name.length < 2 || name.length > 60 || !/^\p{L}[\p{L}\p{M} .'-]*$/u.test(name) || name.split(/\s+/u).length > 4) return false;
  return !/(?:^|\s)(?:hello|hi|hey|who|what|how|services?|service|مرحبا|مرحبًا|أهلا|اهلا|شو|ماذا|كيف|خدمات|خدمة|ما|هل|من)(?:$|\s)/iu.test(name);
}

function safeRequirements(value) {
  if (typeof value === "string") return safeValue(value) || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = [];
  const visit = (item, prefix = "", depth = 0) => {
    if (depth > 3 || !item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item).slice(0, 30)) {
      const label = [prefix, clean(key, 80)].filter(Boolean).join(".");
      if (nested && typeof nested === "object" && !Array.isArray(nested)) visit(nested, label, depth + 1);
      else if (nested != null && String(nested).trim()) entries.push(`${label}: ${safeValue(nested, 120)}`);
    }
  };
  visit(value);
  return entries.slice(0, 12).join("; ") || null;
}

function safeStructured(value, depth = 0) {
  if (depth > 3 || value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return safeValue(value, 500);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeStructured(item, depth + 1)).filter((item) => item != null);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [clean(key, 80), safeStructured(item, depth + 1)]).filter(([, item]) => item != null));
  }
  return null;
}

function normalizeIntent(value) {
  return clean(value, 80).toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeIntents(input) {
  const values = Array.isArray(input) ? input : [input];
  return [...new Set(values.map(normalizeIntent).filter(Boolean))];
}

function routeIntentToDepartment({ intent, intents, defaultDepartment = DEPARTMENTS.general } = {}) {
  const candidates = normalizeIntents(intents || intent);
  const valid = candidates.filter((candidate) => Object.hasOwn(INTENT_ROUTES, candidate));
  const selected = valid.find((candidate) => PRIORITY_INTENTS.has(candidate)) || valid[0];
  const department = selected ? INTENT_ROUTES[selected] : (Object.hasOwn(DEPARTMENTS, defaultDepartment) ? defaultDepartment : DEPARTMENTS.general);
  return {
    intent: selected || "general",
    matchedIntents: valid,
    department,
    validated: Boolean(selected),
    reason: selected ? `validated_${selected}_route` : "unknown_intent_defaulted_to_general"
  };
}

function buildRefalLeadSummary({ customer = {}, conversation = {}, intent, intents, need, timing, value, authority, contact, language, notes, qualification, objections, documents, appointment, sharingScope = "current_inquiry_only" } = {}) {
  const routing = routeIntentToDepartment({ intent, intents });
  const priority = assessPriority({ intent: routing.matchedIntents, text: [need, notes, conversation.lastMessage].filter(Boolean).join(" ") });
  const summary = {
    format: "REFAL LEAD SUMMARY",
    version: 1,
    sharingScope: sharingScope === "current_inquiry_only" ? sharingScope : "current_inquiry_only",
    department: routing.department,
    intent: routing.intent,
    intents: routing.matchedIntents,
    priority: priority.level,
    priorityTriggers: priority.triggers,
    customer: {
      name: (plausibleCustomerName(customer.name || customer.fullName) ? safeValue(customer.name || customer.fullName, 120) : null) || null,
      company: safeValue(customer.company, 160) || null,
      position: safeValue(customer.position, 120) || null,
      country: safeValue(customer.country, 100) || null,
      phone: safeValue(customer.phone || customer.userId, 80) || null,
      // This system-owned WhatsApp routing identifier is deliberately kept
      // distinct from arbitrary phone numbers supplied in free text.
      whatsappContact: clean(customer.whatsappContact, 100) || null,
      email: safeValue(customer.email, 160) || null,
      language: safeValue(language || customer.language, 30) || null
    },
    primaryIntent: routing.intent || null,
    secondaryIntents: routing.matchedIntents.filter((item) => item !== routing.intent),
    opportunity: safeValue(conversation.opportunity || need, 500) || null,
    need: safeValue(need || conversation.need, 500) || null,
    timing: safeValue(timing || conversation.timing, 200) || null,
    value: safeValue(value || conversation.value, 200) || null,
    budget: safeValue(conversation.budget, 200) || null,
    authority: safeValue(authority || conversation.authority, 200) || null,
    contact: safeValue(contact || conversation.preferredContact, 120) || null,
    requirements: safeRequirements(conversation.requirements),
    structuredRequirements: safeStructured(conversation.structuredRequirements || conversation.requirements),
    project: safeValue(conversation.project, 300) || null,
    estimatedValue: safeValue(conversation.estimatedValue, 200) || null,
    decisionAuthority: safeValue(conversation.decisionAuthority, 200) || null,
    recommendedPersonRole: safeValue(conversation.recommendedPersonRole, 200) || null,
    objections: safeValue(objections || conversation.objections, 500) || null,
    documents: safeValue(documents || conversation.documents, 500) || null,
    qualification: qualification || null,
    classification: qualification?.status || null,
    nextAction: safeValue(conversation.nextAction, 240) || null,
    appointment: appointment || null,
    appointmentStatus: safeValue(conversation.appointmentStatus, 100) || null,
    appointmentDate: safeValue(conversation.appointmentDate, 100) || null,
    notes: safeValue(notes || conversation.notes, 500) || null
  };
  return summary;
}

function formatRefalLeadSummary(summary) {
  if (!summary || summary.format !== "REFAL LEAD SUMMARY") throw new Error("A REFAL LEAD SUMMARY object is required.");
  const lines = [
    "REFAL LEAD SUMMARY",
    `Sharing scope: ${summary.sharingScope || "current_inquiry_only"}`,
    `Department: ${summary.department}`,
    `Intent: ${summary.intent}`,
    `Priority: ${summary.priority}`,
    `Customer: ${summary.customer.name || "not provided"}`,
    `Company: ${summary.customer.company || "not provided"}`,
    `Country: ${summary.customer.country || "not provided"}`,
    `Phone: ${summary.customer.phone || "not provided"}`,
    `WhatsApp contact: ${summary.customer.whatsappContact || "not provided"}`,
    `Email: ${summary.customer.email || "not provided"}`,
    `Language: ${summary.customer.language || "not provided"}`,
    `Primary intent: ${summary.primaryIntent || "not provided"}`,
    `Secondary intents: ${summary.secondaryIntents?.join(", ") || "none"}`,
    `Opportunity: ${summary.opportunity || "not provided"}`,
    `Need: ${summary.need || "not provided"}`,
    `Budget: ${summary.budget || "not provided"}`,
    `Timing: ${summary.timing || "not provided"}`,
    `Value: ${summary.value || "not provided"}`,
    `Authority: ${summary.authority || "not provided"}`,
    `Preferred contact: ${summary.contact || "not provided"}`,
    `Requirements: ${summary.requirements || "not provided"}`,
    `Objections: ${summary.objections || "not provided"}`,
    `Documents: ${summary.documents || "not provided"}`,
    `Next action: ${summary.nextAction || "not provided"}`,
    `Notes: ${summary.notes || "not provided"}`
  ];
  return lines.join("\n");
}

function separateCustomerAndInternalMessages({ customerMessage = "", internalMessage = "" } = {}) {
  return {
    customerMessage: clean(customerMessage, 1000),
    internalMessage: clean(internalMessage, 4000),
    customerMayReceiveInternal: false
  };
}

// REFAL-AGENT-014: the previous default was English-only, so a caller that
// omits customerMessage (e.g. agentTools.js's proposeHandover) produced raw
// English text for an Arabic/Greek customer. Localized using the same
// `language` value already threaded through to buildRefalLeadSummary.
function defaultHandoverCustomerMessage(language) {
  if (language === "arabic") return "شكرًا لك. شاركت هذا مع فريق الشركة المختص، وسيتابعون معك.";
  if (language === "greek") return "Ευχαριστώ. Το μοιράστηκα με την αρμόδια ομάδα της Refalco Group, και θα επικοινωνήσουν μαζί σας.";
  return "Thank you. I’ve shared this with the appropriate Refalco Group team, and they will follow up with you.";
}

function createHandover({ input, customerMessage, customer, conversation, intent, intents, need, timing, value, authority, contact, language, notes, sharingScope } = {}) {
  const routing = routeIntentToDepartment({ intent, intents });
  const summary = buildRefalLeadSummary({ customer, conversation, intent: routing.matchedIntents, need, timing, value, authority, contact, language, notes, sharingScope });
  const priority = assessPriority({ intent: routing.matchedIntents, text: input || need || notes });
  return {
    routing: { ...routing, priority: priority.level, handoverRequired: priority.handoverRequired },
    summary,
    messages: separateCustomerAndInternalMessages({
      customerMessage: customerMessage || defaultHandoverCustomerMessage(language),
      internalMessage: formatRefalLeadSummary(summary)
    })
  };
}

function routeIntent({ intent, message = "", complaint = false, existingClient = false } = {}) {
  return routeIntentToDepartment({ intent: complaint ? "complaint" : existingClient ? "existing_client" : intent, defaultDepartment: DEPARTMENTS.general });
}

function createLeadSummary(input = {}) {
  return buildRefalLeadSummary(input);
}

function formatLeadSummary(summary) {
  return formatRefalLeadSummary(summary);
}

function buildHandover({ message = "", ...input } = {}) {
  return createHandover({ input: message, ...input });
}

module.exports = { DEPARTMENTS, INTENT_ROUTES, normalizeIntent, normalizeIntents, routeIntentToDepartment, routeIntent, buildRefalLeadSummary, createLeadSummary, formatRefalLeadSummary, formatLeadSummary, separateCustomerAndInternalMessages, createHandover, buildHandover, safeValue };
