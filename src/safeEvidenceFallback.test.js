const assert = require("node:assert/strict");
const test = require("node:test");
const { selectSafeEvidenceFallback } = require("./safeEvidenceFallback");

test("a concise grounded fallback remains available when the model is unavailable", () => {
  const evidence = [{ content: "The company secretary is included for four consecutive months.", review_status: "approved" }];
  const result = selectSafeEvidenceFallback("The company secretary is included for four consecutive months.", {
    customerMessage: "Is the company secretary included?", evidence, language: "english"
  });
  assert.equal(result.accepted, true);
  assert.match(result.answer, /four consecutive months/u);
});

test("a stale fallback with an unsafe claim fails closed in the customer's language", () => {
  const oldFormationText = "هون بينوجد الكيان القانوني اللي بتقدر تشتغل فيه داخل الاتحاد الأوروبي. 2. حجز واعتماد اسم الشركة لدى السجل القبرصي. 3. تجهيز وتوثيق المستندات حتى يكون الملف سليم وما ينرفض لأسباب إدارية. 4. إصدار الشهادة لفتح الحسابات والتعاقد.";
  const result = selectSafeEvidenceFallback(oldFormationText, {
    customerMessage: "شو بتشمل باقة تأسيس الشركة؟", evidence: [{ content: oldFormationText, review_status: "approved" }], language: "arabic"
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("prohibited_claim") || result.reasons.includes("too_many_sentences"));
  assert.match(result.answer, /معلومة معتمدة/u);
  assert.doesNotMatch(result.answer, /الاتحاد الأوروبي|ما ينرفض|فتح الحسابات/u);
});
