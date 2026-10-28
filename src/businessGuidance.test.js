const test = require("node:test");
const assert = require("node:assert/strict");
const { BUSINESS_GUIDANCE_DEFAULTS, validateBusinessGuidance, businessGuidanceInstruction } = require("./businessGuidance");

const RULE = { id: "rule-1", title: "Answer first", language: "all", instruction: "Answer the current question before asking a follow-up.", enabled: true };
const HOOK = { id: "hook-1", title: "Offer a specialist review", when: "The customer asks for help with a complex project.", phrases: {
  en: "A specialist can review the details if you would like.",
  ar: "يمكن لمختص مراجعة التفاصيل إذا بتحب.",
  el: "Ένας σύμβουλος μπορεί να εξετάσει τις λεπτομέρειες, αν θέλετε."
}, enabled: true };

test("business guidance validates bounded, unique, localized rules and hooks", () => {
  const result = validateBusinessGuidance({ rules: [RULE], hooks: [HOOK] });
  assert.equal(result.rules[0].instruction, RULE.instruction);
  assert.equal(result.hooks[0].phrases.ar, HOOK.phrases.ar);
  assert.throws(() => validateBusinessGuidance({ rules: [RULE, { ...RULE, id: "rule-2", title: "ANSWER first!" }] }), /Duplicate business rules/u);
  assert.throws(() => validateBusinessGuidance({ rules: [{ ...RULE, unexpected: true }] }), /unsupported shape/u);
  assert.throws(() => validateBusinessGuidance({ hooks: [HOOK, { ...HOOK, id: "hook-2", title: "Other specialist review", phrases: { ...HOOK.phrases, ar: "يمكن لمختص آخر مراجعة التفاصيل.", el: "Ένας άλλος σύμβουλος μπορεί να εξετάσει τις λεπτομέρειες." } }] }), /Duplicate EN hook wording/u);
  assert.throws(() => validateBusinessGuidance({ rules: Array(13).fill(0).map((_, index) => ({ ...RULE, id: `r-${index}`, title: `Rule ${index}` })) }), /no more than 12/u);
});

test("localized prompt includes only matching rules and hook wording and never elevates them to evidence", () => {
  const guidance = validateBusinessGuidance({ rules: [RULE, { ...RULE, id: "rule-ar", title: "Arabic only", language: "ar", instruction: "Keep the Arabic explanation concise." }], hooks: [HOOK] });
  const arabic = businessGuidanceInstruction(guidance, "arabic");
  assert.match(arabic, /Arabic only/u);
  assert.match(arabic, /يمكن لمختص/u);
  assert.doesNotMatch(arabic, /A specialist can review/u);
  assert.match(arabic, /not company evidence/u);
  assert.match(arabic, /never copy it verbatim/u);
  assert.equal(businessGuidanceInstruction(BUSINESS_GUIDANCE_DEFAULTS, "english"), "");
});

test("Edge business guidance module exactly mirrors the Node validator and localized prompt", async () => {
  const edge = await import("../supabase/functions/rafa-agent-api/businessGuidance.mjs");
  const nodeValue = validateBusinessGuidance({ rules: [RULE], hooks: [HOOK] });
  assert.deepEqual(edge.validateBusinessGuidance(nodeValue), nodeValue);
  for (const language of ["english", "arabic", "greek"]) {
    assert.equal(edge.businessGuidanceInstruction(nodeValue, language), businessGuidanceInstruction(nodeValue, language));
  }
});
