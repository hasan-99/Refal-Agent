"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { buildBrainPrompt } = require("./brainPrompt");

const PROMPT_SURFACES = Object.freeze([
  "src/brainPrompt.js", "src/ai.js", "dashboard/server.js",
  "supabase/functions/rafa-agent-api/brainPrompt.mjs", "config/refal-agent-rules.md",
]);
const CURRENCY_AMOUNT = /(?:€|\$|£|\b(?:EUR|USD|GBP|CHF|AED)\b)\s*\d[\d,.]*(?:\s*(?:k|m|thousand|million))?|\d[\d,.]*(?:\s*(?:k|m|thousand|million))?\s*(?:€|\$|£|\b(?:EUR|USD|GBP|CHF|AED)\b)/giu;
const PROPERTY_REFERENCE = /\b(?:property|unit|villa|apartment|plot|listing)\s*(?:reference\s*)?(?:#|:)?\s*[A-Z]{1,5}[- ]\d{1,6}\b/giu;
const MONEY_MENTION = /(?:€|\$|£|\b(?:EUR|USD|GBP|CHF|AED)\b)\s*\d[\d,.]*(?:\s*(?:k|m|thousand|million))?|\d[\d,.]*(?:\s*(?:k|m|thousand|million))?\s*(?:€|\$|£|\b(?:EUR|USD|GBP|CHF|AED)\b)/giu;
const DYNAMIC_VALUE_CONTEXT = [
  ["formation-package-price", /(?:formation|incorporation|company setup|تأسيس الشركة|σύσταση εταιρείας).{0,45}(?:price|package|€|eur|usd|£|سعر|τιμή)|(?:price|سعر|τιμή).{0,45}(?:formation|incorporation|company setup|تأسيس الشركة|σύσταση εταιρείας)/iu],
  ["reservation-deposit", /(?:reservation|booking|deposit|عربون|προκαταβολή)/iu],
  ["property-unit-price", /(?:unit|property|villa|apartment|plot|listing).{0,45}(?:price|cost|€|eur|usd|£|سعر|τιμή)|(?:price|cost|سعر|τιμή).{0,45}(?:unit|property|villa|apartment|plot|listing)/iu],
  ["government-fee", /(?:government|registry|land registry|application|authority|third.party).{0,45}(?:fee|cost|€|eur|usd|£|رسوم|τέλος)|(?:fee|رسوم|τέλος).{0,45}(?:government|registry|authority|application)/iu],
];

function scanDynamicPromptText(text) {
  const input = String(text ?? "");
  const findings = [];
  for (const [code, pattern] of [["currency-amount", CURRENCY_AMOUNT], ["property-reference", PROPERTY_REFERENCE]]) {
    pattern.lastIndex = 0;
    for (const match of input.matchAll(pattern)) findings.push({ code, value: match[0], index: match.index });
  }
  return findings.sort((a, b) => a.index - b.index);
}

function findFrozenCommercialFacts(text) {
  const input = String(text ?? "");
  const amounts = [...input.matchAll(MONEY_MENTION)];
  return amounts.flatMap((amount) => {
    const start = Math.max(0, amount.index - 60);
    const end = Math.min(input.length, amount.index + amount[0].length + 60);
    const context = input.slice(start, end);
    const match = DYNAMIC_VALUE_CONTEXT.find(([, pattern]) => pattern.test(context));
    return match ? [{ code: match[0], value: amount[0], index: amount.index }] : [];
  });
}

async function collectPromptSurfaces({ readFile = fs.promises.readFile, importModule = (url) => import(url) } = {}) {
  const root = path.resolve(__dirname, "..");
  const rules = await readFile(path.join(root, "config/refal-agent-rules.md"), "utf8");
  const edgeUrl = pathToFileURL(path.join(root, "supabase/functions/rafa-agent-api/brainPrompt.mjs")).href;
  const edge = await importModule(edgeUrl);
  const surfaces = [
    { name: "src/brainPrompt.js customer", text: buildBrainPrompt({ language: "english", message: "", variant: "customer" }).join("\n") },
    { name: "src/brainPrompt.js operator", text: buildBrainPrompt({ variant: "operator" }).join("\n") },
    // ai.js and dashboard/server.js consume these shared prompt constructions.
    { name: "src/ai.js", text: buildBrainPrompt({ language: "english", message: "", variant: "customer" }).join("\n") },
    { name: "dashboard/server.js", text: buildBrainPrompt({ variant: "operator" }).join("\n") },
    { name: "edge operator", text: edge.buildBrainPrompt({ variant: "operator" }).join("\n") },
    { name: "config/refal-agent-rules.md", text: rules },
  ];
  return surfaces;
}

async function auditDynamicDataSeparation(options) {
  const surfaces = await collectPromptSurfaces(options);
  return surfaces.flatMap(({ name, text }) => scanDynamicPromptText(text).map((finding) => ({ ...finding, surface: name })));
}

module.exports = { PROMPT_SURFACES, scanDynamicPromptText, findFrozenCommercialFacts, collectPromptSurfaces, auditDynamicDataSeparation };
