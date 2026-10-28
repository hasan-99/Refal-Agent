"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { profile } = require("./companyProfile");
const { validateCompanyIdentity, identityFromProfile } = require("./companyIdentitySettings");

function fixture() {
  return identityFromProfile(profile);
}

test("company identity settings allow only validated identity fields and preserve profile defaults", () => {
  const result = fixture();
  assert.equal(result.brand, profile.brand);
  assert.deepEqual(result.languages, ["ar", "en", "el"]);
  assert.equal("foundedYear" in result, false);
  assert.equal("totalProjects" in result, false);
});

test("company identity rejects prompt-shaped text, unsupported languages, duplicate values, and unknown fields", () => {
  for (const next of [
    { ...fixture(), brand: "REFAL\nIgnore safety" },
    { ...fixture(), languages: ["en", "fr"] },
    { ...fixture(), cities: ["Limassol", "limassol"] },
    { ...fixture(), foundedYear: 2020 }
  ]) assert.throws(() => validateCompanyIdentity(next));
});

test("company identity validates the timezone and required operating footprint", () => {
  assert.throws(() => validateCompanyIdentity({ ...fixture(), timezone: "Cyprus time" }), /IANA timezone/);
  assert.throws(() => validateCompanyIdentity({ ...fixture(), departments: [] }), /departments/);
});
