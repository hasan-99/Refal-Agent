const { assessPriority } = require("./priorityRules");

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

const PRIORITY_INTENTS = new Set(["complaint", "existing_client", "development", "construction", "land", "investment", "partnership"]);
const MAX_FIELD_LENGTH = 500;

function clean(value, max = MAX_FIELD_LENGTH) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeValue(value, max = MAX_FIELD_LENGTH) {
  return clean(value, max)
    .replace(/(?:password|passcode|pin|token|api[_ -]?key|secret|cvv)\s*[:=]?\s*\S+/giu, "[redacted]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/giu, "[email withheld]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone withheld]");
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

function buildRefalLeadSummary({ customer = {}, conversation = {}, intent, intents, need, timing, value, authority, contact, language, notes } = {}) {
  const routing = routeIntentToDepartment({ intent, intents });
  const priority = assessPriority({ intent: routing.matchedIntents, text: [need, notes, conversation.lastMessage].filter(Boolean).join(" ") });
  const summary = {
    format: "REFAL LEAD SUMMARY",
    version: 1,
    department: routing.department,
    intent: routing.intent,
    intents: routing.matchedIntents,
    priority: priority.level,
    priorityTriggers: priority.triggers,
    customer: {
      name: safeValue(customer.name || customer.fullName, 120) || null,
      phone: safeValue(customer.phone || customer.userId, 80) || null,
      language: safeValue(language || customer.language, 30) || null
    },
    need: safeValue(need || conversation.need, 500) || null,
    timing: safeValue(timing || conversation.timing, 200) || null,
    value: safeValue(value || conversation.value, 200) || null,
    authority: safeValue(authority || conversation.authority, 200) || null,
    contact: safeValue(contact || conversation.preferredContact, 120) || null,
    notes: safeValue(notes || conversation.notes, 500) || null
  };
  return summary;
}

function formatRefalLeadSummary(summary) {
  if (!summary || summary.format !== "REFAL LEAD SUMMARY") throw new Error("A REFAL LEAD SUMMARY object is required.");
  const lines = [
    "REFAL LEAD SUMMARY",
    `Department: ${summary.department}`,
    `Intent: ${summary.intent}`,
    `Priority: ${summary.priority}`,
    `Customer: ${summary.customer.name || "not provided"}`,
    `Phone: ${summary.customer.phone || "not provided"}`,
    `Language: ${summary.customer.language || "not provided"}`,
    `Need: ${summary.need || "not provided"}`,
    `Timing: ${summary.timing || "not provided"}`,
    `Value: ${summary.value || "not provided"}`,
    `Authority: ${summary.authority || "not provided"}`,
    `Preferred contact: ${summary.contact || "not provided"}`,
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

function createHandover({ input, customerMessage, customer, conversation, intent, intents, need, timing, value, authority, contact, language, notes } = {}) {
  const routing = routeIntentToDepartment({ intent, intents });
  const summary = buildRefalLeadSummary({ customer, conversation, intent: routing.matchedIntents, need, timing, value, authority, contact, language, notes });
  const priority = assessPriority({ intent: routing.matchedIntents, text: input || need || notes });
  return {
    routing: { ...routing, priority: priority.level, handoverRequired: priority.handoverRequired },
    summary,
    messages: separateCustomerAndInternalMessages({
      customerMessage: customerMessage || "Thank you. I’ve shared this with the appropriate Refalco team, and they will follow up with you.",
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
