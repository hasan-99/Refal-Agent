"use strict";

const raw = require("../config/trilingual-glossary.json");

const LANGUAGES = Object.freeze(["ar", "en", "el"]);
const terms = Object.freeze(raw.terms.map((term) => Object.freeze({ ...term })));

function validateGlossary(glossary = raw) {
  const errors = [];
  if (glossary.schemaVersion !== 1) errors.push("unsupported schemaVersion");
  if (glossary.policy !== "canonical-labels-only") errors.push("policy must be canonical-labels-only");
  if (glossary.nativeReviewStatus !== "pending") errors.push("nativeReviewStatus must remain pending until native reviewers sign off");
  if (!Array.isArray(glossary.reviewedLanguages) || glossary.reviewedLanguages.some((language) => !LANGUAGES.includes(language))) errors.push("reviewedLanguages must list only supported languages");
  if (!Array.isArray(glossary.terms) || glossary.terms.length === 0) return [...errors, "terms must be a non-empty array"];
  const ids = new Set();
  for (const [index, term] of glossary.terms.entries()) {
    if (!term || typeof term !== "object") { errors.push(`terms[${index}] must be an object`); continue; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(term.id || "")) errors.push(`terms[${index}].id is invalid`);
    if (ids.has(term.id)) errors.push(`duplicate term id: ${term.id}`);
    ids.add(term.id);
    if (typeof term.canonical !== "string" || !term.canonical.trim()) errors.push(`terms[${index}].canonical is required`);
    if (!/^[a-z-]+$/u.test(term.category || "")) errors.push(`terms[${index}].category is invalid`);
    // The file intentionally stores one approved canonical spelling, not
    // guessed per-language translations or expansions.
    if (Object.hasOwn(term, "translations") || Object.hasOwn(term, "definitions")) {
      errors.push(`terms[${index}] must not contain unreviewed translations or definitions`);
    }
  }
  if (typeof glossary.translationPolicy !== "string" || !glossary.translationPolicy.trim()) errors.push("translationPolicy is required");
  return errors;
}

function canonicalTermList() {
  return terms.map(({ canonical }) => canonical).join(", ");
}

if (validateGlossary().length) throw new Error(`Invalid trilingual glossary: ${validateGlossary().join("; ")}`);

module.exports = { LANGUAGES, terms, canonicalTermList, validateGlossary };
