const test = require("node:test");
const assert = require("node:assert/strict");
const { TYPES, typeForIntents, updateIntake } = require("./opportunityIntake");

test("maps owner intents to progressive intake types", () => {
  assert.equal(typeForIntents(["company_formation", "vat"]), TYPES.COMPANY_FORMATION);
  assert.equal(typeForIntents(["land_owner", "property_development"]), TYPES.LAND_DEVELOPMENT);
  assert.equal(typeForIntents(["construction_tender"]), TYPES.CONSTRUCTION);
  assert.equal(typeForIntents(["strategic_partnership"]), TYPES.PARTNERSHIP);
});
test("stores only supplied facts and reports missing fields", () => {
  const result = updateIntake(null, { intents: ["property_development"], text: "We own land in Limassol with a €20M value and need it next month." });
  assert.equal(result.type, TYPES.LAND_DEVELOPMENT);
  assert.equal(result.data.location, "Limassol");
  assert.equal(result.data.budget, "€20M");
  assert.equal(result.provenance.location, "customer_provided");
  assert.ok(result.missingFields.includes("cooperationStructure"));
});
test("normalizes labelled formation and development facts without inventing values", () => {
  const company = updateIntake(null, { intents: ["company_formation"], text: "business activity: software; country of residence: Cyprus; shareholders: 2; VAT: required" });
  assert.equal(company.data.businessActivity, "software");
  assert.equal(company.data.countryOfResidence, "Cyprus");
  assert.equal(company.data.numberOfShareholders, "2");
  assert.equal(company.data.vatNeeds, "required");
  assert.equal(company.data.email, undefined);
  const build = updateIntake(null, { intents: ["construction_tender"], text: "project type: hotel; planning permit: approved; BOQ: available; project value: €20M" });
  assert.equal(build.data.projectType, "hotel");
  assert.equal(build.data.planningPermit, "approved");
  assert.equal(build.data.boq, "available");
  assert.equal(build.data.approximateProjectValue, "€20M");
});
