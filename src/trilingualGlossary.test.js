"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const glossary = require("./trilingualGlossary");

test("canonical multilingual glossary validates and retains exact approved labels", () => {
  assert.deepEqual(glossary.validateGlossary(), []);
  assert.deepEqual(glossary.LANGUAGES, ["ar", "en", "el"]);
  assert.deepEqual(glossary.terms.map(({ canonical }) => canonical), ["Ltd", "IP Box", "Non-Dom", "EORI", "GESY", "AIF"]);
  assert.equal(glossary.canonicalTermList(), "Ltd, IP Box, Non-Dom, EORI, GESY, AIF");
});

test("glossary rejects guessed translations and definitions", () => {
  const bad = { schemaVersion: 1, policy: "canonical-labels-only", translationPolicy: "fallback", terms: [
    { id: "gesy", canonical: "GESY", category: "health-system", translations: { ar: "invented" } }
  ] };
  assert.match(glossary.validateGlossary(bad).join(" "), /must not contain unreviewed translations or definitions/);
});
