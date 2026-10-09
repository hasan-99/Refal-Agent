const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { profile, load, validate, describeCount, SUPPORTED_LANGUAGES } = require("./companyProfile");

function writeTempProfile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "refal-profile-")), "company-profile.json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return file;
}

function validProfile(overrides = {}) {
  return {
    legalName: "Refalco Group",
    brand: "REFAL",
    groupName: "Refalco Group",
    foundedYear: 2000,
    yearsExperience: 20,
    developmentProjects: 47,
    totalProjects: 400,
    jurisdiction: "Cyprus",
    timezone: "Europe/Nicosia",
    cities: ["Limassol"],
    departments: ["Corporate"],
    languages: ["ar", "en", "el"],
    ...overrides
  };
}

test("the shipped profile loads and carries REFAL's identity", () => {
  assert.equal(profile.brand, "REFAL");
  // Confirmed by BOSS 2026-10-08. The source documents only ever say "Refalco
  // Group"; the registered entity name came from him directly.
  assert.equal(profile.legalName, "Refalco Group Ltd");
  assert.equal(profile.groupName, "Refalco Group");
  assert.equal(profile.jurisdiction, "Cyprus");
  assert.equal(profile.timezone, "Europe/Nicosia");
  assert.deepEqual(profile.languages, SUPPORTED_LANGUAGES);
});

test("the four credibility numbers match the master brain", () => {
  assert.equal(profile.foundedYear, 2000);
  assert.equal(profile.yearsExperience, 20);
  assert.equal(profile.developmentProjects, 47);
  assert.equal(profile.totalProjects, 400);
});

test("the profile is frozen, so no caller can mutate REFAL's identity at runtime", () => {
  assert.equal(Object.isFrozen(profile), true);
  // A frozen object only THROWS on assignment in strict mode; CommonJS modules
  // are sloppy by default, so the guarantee to assert is that the write has no
  // effect, not that it raises.
  profile.brand = "something else";
  assert.equal(profile.brand, "REFAL");
  delete profile.groupName;
  assert.equal(profile.groupName, "Refalco Group");
});

test("'more than' figures render with a + and exact ones do not", () => {
  // The master brain says أكثر من 20 عاماً and أكثر من 400 مشروع, but states 47
  // development projects exactly. Rendering 400 flat would misstate the source.
  assert.equal(describeCount("yearsExperience"), "20+");
  assert.equal(describeCount("totalProjects"), "400+");
  assert.equal(describeCount("developmentProjects"), "47");
});

test("a missing profile is a startup error, not a silent downgrade", () => {
  assert.throws(() => load(path.join(os.tmpdir(), "refal-does-not-exist", "company-profile.json")),
    /company-profile: cannot read/);
});

test("a malformed profile fails loudly rather than loading partially", () => {
  assert.throws(() => load(writeTempProfile("{ not json")), /not valid JSON/);
});

test("every required field is enforced", () => {
  for (const key of ["legalName", "brand", "groupName", "jurisdiction", "timezone"]) {
    assert.throws(() => validate(validProfile({ [key]: "" })), new RegExp(`"${key}" must be a non-empty string`));
  }
  for (const key of ["foundedYear", "yearsExperience", "developmentProjects", "totalProjects"]) {
    assert.throws(() => validate(validProfile({ [key]: 0 })), new RegExp(`"${key}" must be a positive integer`));
  }
  for (const key of ["cities", "departments", "languages"]) {
    assert.throws(() => validate(validProfile({ [key]: [] })), new RegExp(`"${key}" must be a non-empty array`));
  }
});

test("the 'the business' placeholder cannot re-enter through the config", () => {
  // BLK-3 is the defect this phase removes; the config must not reintroduce it.
  assert.throws(() => validate(validProfile({ legalName: "the business" })),
    /still contains the "the business" placeholder/);
});

test("an unsupported language is rejected", () => {
  assert.throws(() => validate(validProfile({ languages: ["ar", "fr"] })), /unsupported language\(s\): fr/);
});

test("a founding year in the future is rejected", () => {
  const nextYear = new Date().getUTCFullYear() + 1;
  assert.throws(() => validate(validProfile({ foundedYear: nextYear })), /is in the future/);
});
