"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { INTENTS } = require("./intent");
const { resolveResponseType, responseTypeInstruction, translationTargetLanguage } = require("./responseType");
const { buildGroundingReviewMessages } = require("./semanticGrounding");

test("response type follows the existing intent and attachment review state", () => {
  assert.equal(resolveResponseType({ intents: [INTENTS.GREETING], socialOnlyTurn: true }), "social_response");
  assert.equal(resolveResponseType({ intents: [INTENTS.PRICING] }), "pricing_answer");
  assert.equal(resolveResponseType({ intents: [INTENTS.SERVICES] }), "service_answer");
  assert.equal(resolveResponseType({ intents: [INTENTS.UNKNOWN], attachmentReviewContinuation: true }), "document_review");
  assert.equal(resolveResponseType({ intents: [INTENTS.UNKNOWN], attachmentReviewPending: true }), "document_review");
  assert.equal(resolveResponseType({ intents: [INTENTS.PROMPT_INJECTION] }), "safe_refusal");
  assert.equal(resolveResponseType({ intents: [INTENTS.UNKNOWN], safetyRestricted: true }), "safe_refusal");
  assert.equal(resolveResponseType({ intents: [INTENTS.UNKNOWN] }), "direct_answer");
});

test("a legal-topic safety flag does not overwrite a supported pricing answer type", () => {
  assert.equal(resolveResponseType({ intents: [INTENTS.PRICING, INTENTS.LEGAL], safetyRestricted: true }), "pricing_answer");
});

test("a routed service label does not discard the preflight pricing intent", () => {
  assert.equal(resolveResponseType({ intents: [INTENTS.SERVICES], additionalIntents: [INTENTS.PRICING] }), "pricing_answer");
});

test("a current price-inclusion question remains a pricing answer when classifiers emphasize banking", () => {
  assert.equal(resolveResponseType({ intents: [INTENTS.BANKING, INTENTS.SERVICES],
    currentMessage: "هل سعر التأسيس يشمل فتح حساب بنكي؟" }), "pricing_answer");
});

test("package inclusions and exclusions use the pricing response type across supported languages", () => {
  const cases = [
    ["ممكن تذكرلي بالتحديد شو داخل بباقة الـ999 يورو وشو الأشياء اللي ما بتشملها؟", [INTENTS.UNKNOWN]],
    ["Which services are included in and excluded from the €999 company formation package in Cyprus?", [INTENTS.COMPANY_FORMATION, INTENTS.SERVICES]],
    ["Ποιες υπηρεσίες περιλαμβάνει το πακέτο σύστασης εταιρείας στην Κύπρο και τι δεν περιλαμβάνει;", [INTENTS.SERVICES]]
  ];
  for (const [currentMessage, intents] of cases) {
    assert.equal(resolveResponseType({ intents, currentMessage }), "pricing_answer", currentMessage);
  }
});

test("a translation task takes precedence over company-topic words inside the text to translate", () => {
  assert.equal(resolveResponseType({ intents: [INTENTS.COMPANY_FORMATION],
    currentMessage: "How would you translate ‘company formation’ into Greek?" }), "direct_answer");
  assert.equal(translationTargetLanguage("How would you translate ‘company formation’ into Greek?"), "greek");
  assert.equal(translationTargetLanguage("ترجم عبارة تأسيس شركة إلى اليونانية"), "greek");
  assert.equal(translationTargetLanguage("Μετάφρασε τη φράση σύσταση εταιρείας στα αγγλικά"), "english");
});

test("response type remains tied to the original customer intent during validation and fallback recovery", () => {
  assert.equal(resolveResponseType({ intents: [INTENTS.PRICING], outcome: "responded" }), "pricing_answer");
  assert.equal(resolveResponseType({ intents: [INTENTS.PRICING], outcome: "response_rejected" }), "pricing_answer");
  assert.equal(resolveResponseType({ intents: [INTENTS.PRICING], outcome: "safe_fallback" }), "pricing_answer");
});

test("response type directive names the selected task without supplying a canned reply", () => {
  const directive = responseTypeInstruction("pricing_answer");
  assert.match(directive, /Required response type: pricing_answer/u);
  assert.match(directive, /current approved evidence/u);
  assert.match(directive, /included only for a period/u);
  assert.match(directive, /each requested inclusion and exclusion/u);
  assert.match(directive, /registration-confirmation conditions/u);
  assert.match(directive, /Do not add possible fee categories/u);
  assert.doesNotMatch(directive, /€999|I can help|How can I assist/u);
});

test("grounding review receives the same response type used for generation and retries", () => {
  const messages = buildGroundingReviewMessages({ text: "The answer.", context: { responseType: "pricing_answer", locale: "english" } });
  assert.match(messages[0].content, /Preserve the selected response type/u);
  assert.equal(JSON.parse(messages[1].content).responseType, "pricing_answer");
});
