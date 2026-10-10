"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { UNKNOWN, buildExecutiveHandoff } = require("./executiveHandoff");

const EMPTY_GOLDEN = [
  "==================================================",
  "REFAL LEAD SUMMARY — EXECUTIVE HANDOFF",
  "==================================================",
  "CLIENT PROFILE:",
  `- Name: ${UNKNOWN}`,
  `- Phone/WhatsApp: ${UNKNOWN}`,
  `- Email: ${UNKNOWN}`,
  `- Country of Residence: ${UNKNOWN}`,
  `- Nationality: ${UNKNOWN}`,
  `- Language: ${UNKNOWN}`,
  "",
  "COMMERCIAL INTENT & OPPORTUNITY:",
  `- Primary Intent: ${UNKNOWN}`,
  `- Secondary Intent: ${UNKNOWN}`,
  `- Business Activity / Project: ${UNKNOWN}`,
  `- Estimated Budget / Value: ${UNKNOWN}`,
  `- Timeline: ${UNKNOWN}`,
  `- Decision Authority: ${UNKNOWN}`,
  "",
  "QUALIFICATION & SCORE:",
  `- Lead Score: ${UNKNOWN}`,
  `- Lead Classification: ${UNKNOWN}`,
  `- Main Motivation: ${UNKNOWN}`,
  `- Main Concern / Objection: ${UNKNOWN}`,
  "",
  "RECOMMENDATION & ROUTING:",
  `- Recommended Department: ${UNKNOWN}`,
  `- Assigned Consultant / Role: ${UNKNOWN}`,
  `- Recommended Next Action: ${UNKNOWN}`,
  `- Appointment Status: ${UNKNOWN}`,
  `- Appointment Date & Time: ${UNKNOWN}`,
  "",
  "CONVERSATION SUMMARY:",
  UNKNOWN,
  "=================================================="
].join("\n");

test("renders the exact MB 5.2 section order, field names, and separators", () => {
  assert.equal(buildExecutiveHandoff(), EMPTY_GOLDEN);
});

test("carries CRM, qualification, intake, routing, and confirmed appointment values", () => {
  const text = buildExecutiveHandoff({
    customer: { name: "Rami Haddad", phone: "+357 99123456", email: "rami@example.com", nationality: "Jordanian", country: "Cyprus", language: "English" },
    crm: { nationality: "Jordanian" },
    opportunityIntake: { type: "construction", data: { projectType: "Hotel", approximateProjectValue: "€4 million", timeline: "Q4", boq: "Customer has a bill of quantities" } },
    intent: "construction_tender", secondaryIntents: ["land_development"], decisionAuthority: "Owner",
    qualification: { total: 25, status: "strategic" }, mainMotivation: "Develop a hotel", objection: "Needs timeline clarity",
    routing: { department: "development_construction" }, assignedConsultant: "Senior construction adviser",
    nextAction: "Review the tender documents", appointment: { status: "confirmed", dateTime: "2026-11-12 10:00 Europe/Nicosia" },
    conversationSummary: "Customer owns the project.\nRequested a tender review."
  }, { role: "adviser" });
  for (const value of ["Rami Haddad", "construction_tender", "land_development", "Hotel", "€4 million", "Intake boq: Customer has a bill of quantities", "25 / 30", "strategic", "Senior construction adviser", "CONFIRMED", "2026-11-12 10:00 Europe/Nicosia"]) {
    assert.ok(text.includes(value), `missing ${value}`);
  }
  assert.match(text, /Appointment Status: CONFIRMED/);
});

test("carries every non-dedicated M8 CRM field for advisers in the fixed summary slot", () => {
  const text = buildExecutiveHandoff({ crm: {
    targetService: "Corporate banking",
    existingOrNewBusiness: "New business",
    targetMarkets: ["Cyprus", "Greece"],
    bankingGatewayNeed: "Business account",
    residencyInterest: "Permanent residency information",
    preferredCity: "Limassol",
    purpose: "Living",
    familyMembers: "Two adults and one child",
    sourceOfFundsStatus: "Documents available",
    sourceOfWealthOverview: "Operating company income",
    mainFearObjection: "Concerned about timing"
  } }, { role: "adviser" });
  for (const value of ["Target Service: Corporate banking", "Existing/New Business: New business", "Target Markets: Cyprus, Greece", "Banking/Gateway Need: Business account", "Residency Interest: Permanent residency information", "Preferred City: Limassol", "Purpose: Living", "Family Members: Two adults and one child", "Source of Funds Status: Documents available", "Source of Wealth Overview: Operating company income", "Main Fear/Objection: Concerned about timing"]) assert.ok(text.includes(value), value);
  assert.match(text, /CONVERSATION SUMMARY:[\s\S]*CRM details:/);
});

test("limited roles do not receive additional M8 CRM details", () => {
  const text = buildExecutiveHandoff({ crm: { sourceOfWealthOverview: "Sensitive private source detail" } }, { role: "viewer" });
  assert.doesNotMatch(text, /Sensitive private source detail/);
});

test("uses UNKNOWN / NOT PROVIDED for absent fields and PENDING for an explicit unconfirmed appointment", () => {
  const text = buildExecutiveHandoff({ appointment: { status: "pending_calendar" } });
  assert.match(text, /Appointment Status: PENDING/);
  assert.match(text, /Assigned Consultant \/ Role: UNKNOWN \/ NOT PROVIDED/);
  assert.match(text, /Appointment Date & Time: UNKNOWN \/ NOT PROVIDED/);
});

test("redacts credential and banking values for every role", () => {
  const input = {
    conversationSummary: "Bank account: CY17002001280000001200527600; password: hunter2; API token=sk-12345678901234567890"
  };
  for (const role of ["adviser", "admin", "viewer", "customer"]) {
    const text = buildExecutiveHandoff(input, { role });
    assert.doesNotMatch(text, /CY17002001280000001200527600|hunter2|sk-12345678901234567890/, role);
    assert.match(text, /\[redacted\]|\[redacted banking details\]/, role);
  }
});

test("limited roles receive the same fixed block with contact routes withheld", () => {
  const text = buildExecutiveHandoff({
    customer: { phone: "+357 99123456", email: "rami@example.com", name: "Rami" }
  }, { role: "viewer" });
  assert.match(text, /- Name: Rami/);
  assert.match(text, /- Phone\/WhatsApp: \[withheld\]/);
  assert.match(text, /- Email: \[withheld\]/);
  assert.doesNotMatch(text, /\+357 99123456|rami@example\.com/);
});

test("adviser and admin roles can see contact routes while all other roles fail closed", () => {
  const input = { customer: { phone: "+357 99123456", email: "rami@example.com" } };
  for (const role of ["adviser", "admin"]) {
    const text = buildExecutiveHandoff(input, { role });
    assert.match(text, /Phone\/WhatsApp: \+357 99123456/);
    assert.match(text, /Email: rami@example\.com/);
  }
  for (const role of ["viewer", "customer", "unknown-role"]) {
    const text = buildExecutiveHandoff(input, { role });
    assert.doesNotMatch(text, /\+357 99123456|rami@example\.com/);
    assert.match(text, /Phone\/WhatsApp: \[withheld\]/);
    assert.match(text, /Email: \[withheld\]/);
  }
});

test("role based phone visibility handles Arabic-Indic and Persian digits", () => {
  const phones = ["+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧", "+۹۸۹۱۲۳۴۵۶۷۸"];
  for (const role of ["viewer", "support", "operator", "limited", "customer", "unknown-role"]) {
    for (const phone of phones) {
      const text = buildExecutiveHandoff({ customer: { phone } }, { role });
      assert.equal(text.includes(phone), false, `${role}: ${phone}`);
      assert.match(text, /Phone\/WhatsApp: \[withheld\]/, role);
    }
  }
  for (const role of ["adviser", "admin"]) {
    for (const phone of phones) {
      const text = buildExecutiveHandoff({ customer: { phone } }, { role });
      assert.ok(text.includes(phone), `${role}: ${phone}`);
    }
  }
});

test("only an explicit confirmed appointment status renders CONFIRMED", () => {
  const untrustedBoolean = buildExecutiveHandoff({ appointment: { confirmed: true } });
  const missingStatus = buildExecutiveHandoff({ appointment: { date: "2026-11-12", confirmed: true } });
  const explicit = buildExecutiveHandoff({ appointment: { status: "confirmed" } });
  assert.match(untrustedBoolean, /Appointment Status: UNKNOWN \/ NOT PROVIDED/);
  assert.match(missingStatus, /Appointment Status: UNKNOWN \/ NOT PROVIDED/);
  assert.match(explicit, /Appointment Status: CONFIRMED/);
});

test("does not stringify objects or accept an unconfirmed appointment as confirmed", () => {
  const text = buildExecutiveHandoff({
    customer: { name: { first: "Rami" } },
    appointment: { status: "creating", date: "tomorrow" }
  });
  assert.doesNotMatch(text, /\[object Object\]|tomorrow/);
  assert.match(text, /Appointment Status: UNKNOWN \/ NOT PROVIDED/);
});
