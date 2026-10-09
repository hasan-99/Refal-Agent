const fs = require("node:fs");
const path = require("node:path");

// P1.1 / W1.1.2. Loads, validates and freezes REFAL's company identity.
//
// A MISSING OR INVALID PROFILE IS A STARTUP ERROR, NOT A SILENT DOWNGRADE.
// That is the whole point of this module. The defect it replaces (BLK-3) was the
// agent falling back to the literal placeholder "the business" and shipping it to
// customers in three languages. A loud failure at boot is strictly better than a
// bot that politely introduces itself as "the business".

const PROFILE_PATH = path.join(__dirname, "..", "config", "company-profile.json");

const REQUIRED_STRINGS = ["legalName", "brand", "groupName", "jurisdiction", "timezone"];
const REQUIRED_NUMBERS = ["foundedYear", "yearsExperience", "developmentProjects", "totalProjects"];
const REQUIRED_ARRAYS = ["cities", "departments", "languages"];
const SUPPORTED_LANGUAGES = ["ar", "en", "el"];

function fail(reason) {
  throw new Error(`company-profile: ${reason}. Expected a valid profile at ${PROFILE_PATH}.`);
}

function validate(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("profile is not an object");

  for (const key of REQUIRED_STRINGS) {
    if (typeof profile[key] !== "string" || !profile[key].trim()) fail(`"${key}" must be a non-empty string`);
  }
  for (const key of REQUIRED_NUMBERS) {
    if (!Number.isInteger(profile[key]) || profile[key] <= 0) fail(`"${key}" must be a positive integer`);
  }
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(profile[key]) || !profile[key].length) fail(`"${key}" must be a non-empty array`);
    if (profile[key].some((entry) => typeof entry !== "string" || !entry.trim())) {
      fail(`"${key}" must contain only non-empty strings`);
    }
  }

  // The placeholder this phase exists to remove must never re-enter through the
  // config file itself.
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value === "string" && /\bthe business\b/i.test(value)) {
      fail(`"${key}" still contains the "the business" placeholder`);
    }
  }

  const unsupported = profile.languages.filter((lang) => !SUPPORTED_LANGUAGES.includes(lang));
  if (unsupported.length) fail(`unsupported language(s): ${unsupported.join(", ")}`);

  const currentYear = new Date().getUTCFullYear();
  if (profile.foundedYear > currentYear) fail(`"foundedYear" (${profile.foundedYear}) is in the future`);

  return profile;
}

function load(profilePath = PROFILE_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(profilePath, "utf8");
  } catch (error) {
    throw new Error(`company-profile: cannot read ${profilePath} (${error.code || error.message}). `
      + "This file is required; REFAL must not start without its identity.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`company-profile: ${profilePath} is not valid JSON (${error.message}).`);
  }

  return Object.freeze(validate(parsed));
}

const profile = load();

// `yearsExperience` and `totalProjects` are recorded in the master brain as
// "more than" figures (أكثر من). Surfacing them as flat numbers would misstate
// the source, so callers that render them for a customer must use this.
function describeCount(key) {
  const value = profile[key];
  if (typeof value !== "number") fail(`"${key}" is not a numeric field`);
  return profile[`${key}IsMinimum`] ? `${value}+` : String(value);
}

// PROFILE_PATH is deliberately NOT exported: it had zero consumers anywhere in
// the repo, including this module's own test. It stays a local constant used by
// fail() to make the error message actionable.
module.exports = { profile, load, validate, describeCount, SUPPORTED_LANGUAGES };
