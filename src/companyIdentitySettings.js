"use strict";

const IDENTITY_STRING_FIELDS = Object.freeze(["legalName", "brand", "groupName", "jurisdiction", "timezone"]);
const IDENTITY_LIST_FIELDS = Object.freeze(["cities", "departments", "languages"]);
const SUPPORTED_IDENTITY_LANGUAGES = Object.freeze(["ar", "en", "el"]);
const SAFE_IDENTITY_TEXT = /^[\p{L}\p{M}\p{N}\s&.'’(),\-/]+$/u;

/** @typedef {{ legalName: string, brand: string, groupName: string, jurisdiction: string, timezone: string, cities: readonly string[], departments: readonly string[], languages: readonly string[] }} CompanyIdentity */

function validateIdentityText(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (!text || text.length > 120 || !SAFE_IDENTITY_TEXT.test(text) || /[\r\n\t]/u.test(text)) {
    throw new Error(`${field} must be 1–120 characters and contain plain name text.`);
  }
  return text;
}

/** @param {unknown} value @returns {Readonly<CompanyIdentity>} */
function validateCompanyIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Company identity must be an object.");
  const allowed = new Set([...IDENTITY_STRING_FIELDS, ...IDENTITY_LIST_FIELDS]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Company identity contains an unsupported field.");

  const identity = {};
  for (const field of IDENTITY_STRING_FIELDS) identity[field] = validateIdentityText(value[field], field);
  try { new Intl.DateTimeFormat("en", { timeZone: identity.timezone }); }
  catch { throw new Error("Timezone must be a supported IANA timezone."); }

  for (const field of IDENTITY_LIST_FIELDS) {
    const entries = value[field];
    const max = field === "languages" ? 3 : 30;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > max) throw new Error(`${field} must contain 1–${max} entries.`);
    const normalized = entries.map((entry) => validateIdentityText(entry, field));
    const unique = [...new Set(normalized.map((entry) => entry.toLocaleLowerCase()))];
    if (unique.length !== normalized.length) throw new Error(`${field} cannot contain duplicate entries.`);
    if (field === "languages" && normalized.some((language) => !SUPPORTED_IDENTITY_LANGUAGES.includes(language))) {
      throw new Error("Languages must use the supported language codes: ar, en, or el.");
    }
    identity[field] = normalized;
  }
  return Object.freeze({
    ...identity,
    cities: Object.freeze(identity.cities),
    departments: Object.freeze(identity.departments),
    languages: Object.freeze(identity.languages)
  });
}

function identityFromProfile(profile) {
  return validateCompanyIdentity(Object.fromEntries([...IDENTITY_STRING_FIELDS, ...IDENTITY_LIST_FIELDS].map((field) => [field, profile?.[field]])));
}

module.exports = { IDENTITY_STRING_FIELDS, IDENTITY_LIST_FIELDS, SUPPORTED_IDENTITY_LANGUAGES, validateCompanyIdentity, identityFromProfile };
