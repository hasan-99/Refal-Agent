import test from "node:test";
import assert from "node:assert/strict";
import { COMPANY_IDENTITY_CHANGE_REASONS, companyIdentityView } from "./companyIdentity.js";

test("company identity change reasons match the controlled audit codes", () => {
  assert.deepEqual(COMPANY_IDENTITY_CHANGE_REASONS.map(({ value }) => value), [
    "clarify_customer_follow_up",
    "improve_localized_wording",
    "align_with_approved_process",
    "remove_outdated_guidance",
    "other_operational_adjustment"
  ]);
  assert.ok(COMPANY_IDENTITY_CHANGE_REASONS.every(({ label }) => label.length > 0));
});

test("company identity view exposes validated identity and omits credibility facts", () => {
  const result = companyIdentityView({
    legalName: "Refalco Group Ltd",
    brand: "REFAL",
    groupName: "Refalco Group",
    jurisdiction: "Cyprus",
    timezone: "Europe/Nicosia",
    cities: ["Limassol", "Larnaca"],
    departments: ["Corporate", "Tax"],
    languages: ["ar", "en", "el"],
    foundedYear: 2000,
    yearsExperience: 20,
    developmentProjects: 47,
    totalProjects: 400,
    yearsExperienceIsMinimum: true
  });

  assert.deepEqual(Object.keys(result), ["legalName", "brand", "groupName", "jurisdiction", "timezone", "cities", "departments", "languages"]);
  assert.equal(JSON.stringify(result).includes("2000"), false);
  assert.equal(JSON.stringify(result).includes("400"), false);
});

test("company identity view rejects incomplete data instead of returning placeholders", () => {
  assert.throws(() => companyIdentityView({ brand: "REFAL" }), /identity field legalName is invalid/);
});
