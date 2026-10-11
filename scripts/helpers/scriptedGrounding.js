"use strict";
// Explicit offline provider double for existing scripted-decision tests.
// Retain their original factual and language gates; real provider review is
// exercised separately. Never use this helper in customer message handling.
const { validateFactualGrounding } = require("../../src/groundingPolicy");
const { languageSignalsFrom } = require("../../src/agentObservability");
function scriptedGrounding({ text, evidenceItems, dynamicEvidenceItems, context }) {
  const factual = validateFactualGrounding(text, { evidenceItems, dynamicEvidenceItems });
  if (!factual.valid) return factual;
  const language = languageSignalsFrom(context.locale, text);
  return { valid: !language.languageMismatch, reasons: language.languageMismatch ? ["language_mismatch"] : [] };
}
function runAgentTurnForContact(input, options = {}) {
  return require("../../src/agentRuntime").runAgentTurnForContact(input, { assessDraft: scriptedGrounding, ...options });
}
module.exports = { scriptedGrounding, runAgentTurnForContact };
