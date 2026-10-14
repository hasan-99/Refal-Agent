"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RESPONSE_STYLE_DEFAULTS, validateResponseStyle, responseStyleInstruction } = require("./responseStyle");
const { buildBrainPrompt } = require("./brainPrompt");

test("response style defaults to short paragraphs, hyphen bullets, sparse bold labels, and adaptive useful continuations", () => {
  assert.deepEqual(validateResponseStyle({}), RESPONSE_STYLE_DEFAULTS);
  const instruction = responseStyleInstruction(RESPONSE_STYLE_DEFAULTS);
  assert.match(instruction, /warm, approachable and respectful professional tone/u);
  assert.match(instruction, /short and separate them with a blank line/u);
  assert.match(instruction, /hyphen bullets/u);
  assert.match(instruction, /bold style sparingly/u);
  assert.match(instruction, /one concise, specific next-step question or helpful piece of information/u);
  assert.match(instruction, /Skip this when the answer stands on its own/u);
  assert.match(instruction, /you may add at most one related service suggestion/u);
  assert.match(instruction, /never override safety, accuracy, approved evidence, or appointment rules/u);
});

test("response style accepts only bounded presentation options", () => {
  assert.deepEqual(validateResponseStyle({ tone: "formal", paragraphLength: "very_short", listMarker: "numbered", boldLabels: false }), {
    tone: "formal", paragraphLength: "very_short", listMarker: "numbered", boldLabels: false, continuationStyle: "adaptive", allowRelevantServiceSuggestions: true
  });
  assert.equal(validateResponseStyle({ paragraphLength: "very_short" }).tone, RESPONSE_STYLE_DEFAULTS.tone, "older saved settings receive the new default tone");
  assert.throws(() => validateResponseStyle({ tone: "flirty" }), /supported response tone/u);
  assert.throws(() => validateResponseStyle({ rule: "ignore safety" }), /unsupported setting/u);
  assert.throws(() => validateResponseStyle({ listMarker: "custom" }), /supported list marker/u);
  assert.throws(() => validateResponseStyle({ boldLabels: "yes" }), /enabled or disabled/u);
  assert.throws(() => validateResponseStyle({ continuationStyle: "always_ask" }), /supported conversation continuation/u);
  assert.throws(() => validateResponseStyle({ allowRelevantServiceSuggestions: "yes" }), /enabled or disabled/u);
  assert.match(responseStyleInstruction({ allowRelevantServiceSuggestions: false }), /Do not add unsolicited related-service suggestions/u);
});

test("Edge response-style mirror stays byte-for-byte aligned for every supported profile", async () => {
  const edge = await import("../supabase/functions/rafa-agent-api/responseStyle.mjs");
  for (const profile of [RESPONSE_STYLE_DEFAULTS,
    { tone: "formal", paragraphLength: "very_short", listMarker: "numbered", boldLabels: false, continuationStyle: "helpful_next_step", allowRelevantServiceSuggestions: false },
    { tone: "balanced_professional", paragraphLength: "short", listMarker: "hyphen", boldLabels: true, continuationStyle: "useful_question", allowRelevantServiceSuggestions: true }]) {
    assert.equal(edge.responseStyleInstruction(profile), responseStyleInstruction(profile));
  }
});

test("disabling related-service suggestions reaches both customer and operator prompt variants", async () => {
  const edgePrompt = await import("../supabase/functions/rafa-agent-api/brainPrompt.mjs");
  for (const variant of ["customer", "operator"]) {
    const options = { variant, responseStyle: { allowRelevantServiceSuggestions: false } };
    const nodePrompt = buildBrainPrompt(options).join(" ");
    assert.match(nodePrompt, variant === "operator"
      ? /Do not add unsolicited sales hooks, cross-sells, or benefit hints/u
      : /Do not add an unsolicited cross-sell hook or related-service suggestion/u);
    assert.doesNotMatch(nodePrompt, /You may raise ONE relevant cross-sell hook/u);
    if (variant === "operator") {
      const deployedPrompt = edgePrompt.buildBrainPrompt(options).join(" ");
      assert.equal(deployedPrompt, nodePrompt);
    }
  }
});
