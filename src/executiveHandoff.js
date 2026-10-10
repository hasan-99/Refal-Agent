"use strict";

const { redactSensitiveData } = require("./sensitiveData");
const { FIELDS: OPPORTUNITY_INTAKE_FIELDS } = require("./opportunityIntake");

const UNKNOWN = "UNKNOWN / NOT PROVIDED";
const MAX_VALUE_LENGTH = 600;
const CONTACT_VISIBLE_ROLES = new Set(["adviser", "admin"]);

function scalar(value) {
  if (Array.isArray(value)) return value.map((item) => (item == null || typeof item === "object" ? "" : String(item))).filter(Boolean).join(", ");
  if (value == null || typeof value === "object") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function safeText(value, { role = "customer", max = MAX_VALUE_LENGTH } = {}) {
  const canViewContact = CONTACT_VISIBLE_ROLES.has(String(role).toLowerCase());
  let text = scalar(value);
  if (!text) return UNKNOWN;
  text = redactSensitiveData(text)
    .replace(/\b(?:password|passcode|pin|token|api[_ -]?key|secret|cvv|cvc|otp)\s*[:=]?\s*\S+/giu, "[redacted]")
    .replace(/\b(?:bank(?:ing)?\s+(?:login|credentials?|account(?:\s+number)?|details)|iban|swift|routing\s+number)\b[^,;.!?\n]*/giu, "[redacted banking details]")
    .trim();
  if (!canViewContact) {
    text = text.replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/giu, "[withheld]")
      .replace(/\+?[\p{Nd}][\p{Nd}\s().-]{7,}[\p{Nd}]/gu, (match) => /\d{4}-\d{2}-\d{2}/u.test(match) ? match : "[withheld]");
  }
  return text.slice(0, max) || UNKNOWN;
}

function first(...values) {
  return values.find((value) => value != null && scalar(value) !== "");
}

function appointmentStatus(appointment) {
  if (!appointment || typeof appointment !== "object") return UNKNOWN;
  if (appointment.status === "confirmed") return "CONFIRMED";
  if (["pending", "pending_calendar", "awaiting_customer_confirmation", "draft"].includes(appointment.status)) return "PENDING";
  return UNKNOWN;
}

/**
 * Render the owner-supplied MB 5.2 internal handoff block. `crm`, typed
 * `opportunityIntake.data`, and the other nested inputs are preserved as
 * future M8 sources; missing information is always shown explicitly.
 * Roles `operator`, `support`, `viewer`, and `limited` receive withheld
 * contact routes. Credentials and banking details are redacted for every role.
 */
function buildExecutiveHandoff(input = {}, { role = "customer" } = {}) {
  const customer = input.customer || {};
  const crm = input.crm || input.crmFields || {};
  const intake = input.opportunityIntake?.data || input.intake?.data || {};
  const intakeType = input.opportunityIntake?.type || input.intake?.type || "";
  const qualification = input.qualification || {};
  const conversation = input.conversation || {};
  const crmOpportunity = crm.opportunity || crm.groups?.opportunity || {};
  const crmProperty = crm.propertyResidency || crm.property_residency || crm.groups?.propertyResidency || {};
  const crmQualification = crm.qualification || crm.groups?.qualification || {};
  const appointment = input.appointment || conversation.appointment;
  const values = {
    name: first(customer.name, customer.fullName, crm.name),
    phone: first(customer.phone, customer.whatsappContact, crm.phone, crm.whatsapp),
    email: first(customer.email, crm.email),
    country: first(customer.countryOfResidence, customer.country, crm.countryOfResidence, crm.country),
    nationality: first(customer.nationality, crm.nationality),
    language: first(customer.language, input.language, crm.language),
    primaryIntent: first(input.primaryIntent, input.intent, conversation.primaryIntent, conversation.intent, intake.topic),
    secondaryIntent: first(input.secondaryIntent, input.secondaryIntents, conversation.secondaryIntent, conversation.secondaryIntents),
    activity: first(input.businessActivity, input.project, conversation.businessActivity, conversation.project, intake.businessActivity, intake.projectType),
    budget: first(input.estimatedBudget, input.estimatedValue, input.budget, conversation.estimatedBudget, conversation.estimatedValue, conversation.budget, intake.budget, intake.capitalRequirement, intake.approximateProjectValue),
    timeline: first(input.timeline, conversation.timeline, intake.timeline, intake.expectedStartDate),
    authority: first(input.decisionAuthority, input.authority, conversation.decisionAuthority, conversation.authority, intake.decisionMakers),
    score: first(input.score, qualification.total, qualification.score),
    classification: first(input.classification, qualification.classification, qualification.status, input.tier),
    motivation: first(input.mainMotivation, input.motivation, conversation.mainMotivation, conversation.motivation, intake.investmentObjective),
    concern: first(input.mainConcern, input.objection, conversation.mainConcern, conversation.objection, conversation.objections),
    department: first(input.recommendedDepartment, input.department, input.routing?.department),
    consultant: first(input.assignedConsultant, input.consultantRole, input.recommendedPersonRole, conversation.assignedConsultant, conversation.recommendedPersonRole),
    nextAction: first(input.recommendedNextAction, input.nextAction, conversation.nextAction),
    appointmentStatus: appointmentStatus(appointment),
    appointmentDate: ["confirmed", "pending_calendar", "pending", "awaiting_customer_confirmation", "draft"].includes(appointment?.status)
      ? first(appointment?.dateTime, appointment?.startTime, appointment?.date, conversation.appointmentDate)
      : undefined,
    summary: first(input.conversationSummary, conversation.summary, conversation.recap)
  };
  // Several P8.1 CRM fields have no dedicated MB 5.2 line. Keep the golden
  // block unchanged and carry them in its existing summary slot for authorized
  // advisers. Limited roles never receive the additional CRM/property data.
  if (CONTACT_VISIBLE_ROLES.has(String(role).toLowerCase())) {
    const details = [
      ["Target Service", first(crm.targetService, crm.target_service, crmOpportunity.targetService, crmOpportunity.target_service)],
      ["Existing/New Business", first(crm.existingOrNewBusiness, crm.existing_or_new_business, crmOpportunity.existingOrNewBusiness, crmOpportunity.existing_or_new_business)],
      ["Target Markets", first(crm.targetMarkets, crm.target_markets, crmOpportunity.targetMarkets, crmOpportunity.target_markets)],
      ["Banking/Gateway Need", first(crm.bankingGatewayNeed, crm.banking_gateway_need, crmOpportunity.bankingGatewayNeed, crmOpportunity.banking_gateway_need)],
      ["Residency Interest", first(crm.residencyInterest, crm.residency_interest, crmProperty.residencyInterest, crmProperty.residency_interest)],
      ["Preferred City", first(crm.preferredCity, crm.preferred_city, crmProperty.preferredCity, crmProperty.preferred_city)],
      ["Purpose", first(crm.purpose, crmProperty.purpose)],
      ["Family Members", first(crm.familyMembers, crm.family_members, crmProperty.familyMembers, crmProperty.family_members)],
      ["Source of Funds Status", first(crm.sourceOfFundsStatus, crm.source_of_funds_status, crmProperty.sourceOfFundsStatus, crmProperty.source_of_funds_status)],
      ["Source of Wealth Overview", first(crm.sourceOfWealthOverview, crm.source_of_wealth_overview, crmProperty.sourceOfWealthOverview, crmProperty.source_of_wealth_overview)],
      ["Main Fear/Objection", first(crm.mainFearObjection, crm.main_fear_objection, crmQualification.mainFearObjection, crmQualification.main_fear_objection)]
    ].filter(([, item]) => item != null && scalar(item));
    const intakeFields = OPPORTUNITY_INTAKE_FIELDS[intakeType] || [];
    for (const key of intakeFields) {
      const item = intake[key];
      if (item == null || !scalar(item) || details.some(([label]) => label.toLowerCase() === key.toLowerCase())) continue;
      details.push([`Intake ${key}`, item]);
    }
    if (details.length) values.summary = [values.summary, `CRM details: ${details.map(([label, item]) => `${label}: ${scalar(item).slice(0, 100)}`).join("; ")}`].filter(Boolean).join(" ");
  }
  const value = (key, max) => key === "appointmentStatus" && values[key] !== UNKNOWN
    ? values[key]
    : safeText(values[key], { role, max });
  const lines = [
    "==================================================",
    "REFAL LEAD SUMMARY — EXECUTIVE HANDOFF",
    "==================================================",
    "CLIENT PROFILE:",
    `- Name: ${value("name", 120)}`,
    `- Phone/WhatsApp: ${value("phone", 100)}`,
    `- Email: ${value("email", 160)}`,
    `- Country of Residence: ${value("country", 120)}`,
    `- Nationality: ${value("nationality", 120)}`,
    `- Language: ${value("language", 40)}`,
    "",
    "COMMERCIAL INTENT & OPPORTUNITY:",
    `- Primary Intent: ${value("primaryIntent", 160)}`,
    `- Secondary Intent: ${value("secondaryIntent", 240)}`,
    `- Business Activity / Project: ${value("activity", 240)}`,
    `- Estimated Budget / Value: ${value("budget", 120)}`,
    `- Timeline: ${value("timeline", 120)}`,
    `- Decision Authority: ${value("authority", 160)}`,
    "",
    "QUALIFICATION & SCORE:",
    `- Lead Score: ${values.score == null ? UNKNOWN : `${safeText(values.score, { role, max: 40 })} / 30`}`,
    `- Lead Classification: ${value("classification", 80)}`,
    `- Main Motivation: ${value("motivation", 200)}`,
    `- Main Concern / Objection: ${value("concern", 200)}`,
    "",
    "RECOMMENDATION & ROUTING:",
    `- Recommended Department: ${value("department", 120)}`,
    `- Assigned Consultant / Role: ${value("consultant", 160)}`,
    `- Recommended Next Action: ${value("nextAction", 200)}`,
    `- Appointment Status: ${value("appointmentStatus", 40)}`,
    `- Appointment Date & Time: ${value("appointmentDate", 120)}`,
    "",
    "CONVERSATION SUMMARY:",
    value("summary", 1800),
    "=================================================="
  ];
  return lines.join("\n");
}

module.exports = { UNKNOWN, buildExecutiveHandoff };
