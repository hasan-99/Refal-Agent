"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  PROMPT_SURFACES, scanDynamicPromptText, collectPromptSurfaces, auditDynamicDataSeparation,
} = require("./dynamicDataSeparation");

test("M4 prompt scan covers each planned exported prompt surface", async () => {
  const surfaces = await collectPromptSurfaces();
  const names = new Set(surfaces.map((surface) => surface.name));
  assert.ok(PROMPT_SURFACES.includes("src/brainPrompt.js"));
  assert.ok(PROMPT_SURFACES.includes("src/ai.js"));
  assert.ok(PROMPT_SURFACES.includes("dashboard/server.js"));
  assert.ok(PROMPT_SURFACES.includes("supabase/functions/rafa-agent-api/brainPrompt.mjs"));
  assert.ok(PROMPT_SURFACES.includes("config/refal-agent-rules.md"));
  for (const name of ["src/brainPrompt.js customer", "src/ai.js", "dashboard/server.js", "edge operator", "config/refal-agent-rules.md"]) {
    assert.ok(names.has(name), `missing prompt surface ${name}`);
  }
  assert.deepEqual(await auditDynamicDataSeparation(), []);
});

test("scanner detects injected prices and property references inside nested prompt output", () => {
  const exportedPrompt = () => ["Agent policy", () => "Property reference: Unit CY-204 costs €245,000"];
  const flattenExport = (value) => Array.isArray(value) ? value.map(flattenExport).join("\n") : typeof value === "function" ? flattenExport(value()) : value;
  const hits = scanDynamicPromptText(flattenExport(exportedPrompt()));
  assert.deepEqual(hits.map(({ code }) => code), ["property-reference", "currency-amount"]);
});

test("scanner detects a currency amount across common currency formatting", () => {
  assert.deepEqual(scanDynamicPromptText("Set price to 999 EUR and another to $1,250.").map((hit) => hit.code), ["currency-amount", "currency-amount"]);
});
