"use strict";

// Support-intent profiles used ONLY to widen first-stage knowledge retrieval.
//
// Each profile is a neutral description of what a customer is asking about,
// written in plain Arabic and English. At search time the customer's question
// embedding is compared with these descriptions; when one is clearly the
// closest, its own embedding is issued as one extra semantic probe so chunks
// about that topic enter the candidate pool even when the customer's wording
// (dialect, spelling, structure) shares no words with the chunk.
//
// What this is NOT:
//   - not keyword or phrase matching: no customer phrasings live here, and the
//     descriptions are never matched as strings;
//   - not knowledge content: nothing here is shown to the model or customer;
//   - not a ranking decision: every candidate, intent-assisted or not, is
//     ranked by the cross-encoder against the customer's full question
//     (src/knowledgeRerank.js), so an intent can add candidates but cannot
//     push an irrelevant chunk above a relevant one.
//
// Keep descriptions short, factual and free of test-set wording
// (src/retrievalRegressionSet.js), or the regression set stops measuring
// meaning.

const SUPPORT_INTENTS = Object.freeze([
  { id: "guarantee", text: "ضمان قبول طلب تأسيس الشركة واحتمال رفض الطلب وما يحدث عند الرفض. guarantee that a company registration application is accepted, the risk of refusal and what happens after a refusal." },
  { id: "refund", text: "استرداد المبلغ المدفوع عند إلغاء الطلب أو العدول عنه وسياسة الإلغاء. getting money back after cancelling an order and the cancellation policy." },
  { id: "complaint", text: "عدم الرضا عن الخدمة وتقديم شكوى وتصعيدها إلى مسؤول. dissatisfaction with the service, making a complaint and escalating it." },
  { id: "tax_advice", text: "طلب رأي مهني في الوضع الضريبي من محاسب أو مستشار ضريبي. asking a professional accountant or tax adviser about a personal tax position." },
  { id: "payment", text: "طريقة سداد الأتعاب والفاتورة والدفعة الأولى والتقسيط. how fees are paid, invoices, deposits and paying in parts." },
  { id: "gov_fees", text: "الرسوم الرسمية التي تفرضها جهة التسجيل الحكومية على تأسيس الشركة. official fees the government registry charges for incorporation." },
  { id: "timeline", text: "المدة الزمنية اللازمة حتى تصبح الشركة مسجلة وجاهزة. how much time it takes until the company is registered and ready." },
  { id: "documents", text: "الوثائق والمستندات التي يجب على العميل تقديمها لتأسيس الشركة. the documents a client has to provide to set up a company." }
]);

/**
 * Picks the support intent whose description is clearly closest to the query.
 * e5 cosine scores are compressed, so an absolute threshold alone is not
 * meaningful; a margin over the runner-up is required as well.
 * @param {Float32Array|number[]} queryEmbedding normalized query vector
 * @param {{ id: string, embedding: Float32Array|number[] }[]} profiles normalized profile vectors
 * @returns {{ id: string, similarity: number, margin: number } | null}
 */
function detectSupportIntent(queryEmbedding, profiles, { minSimilarity = 0.80, minMargin = 0.01 } = {}) {
  if (!queryEmbedding || !Array.isArray(profiles) || profiles.length === 0) return null;
  const scored = profiles
    .filter((p) => p?.embedding)
    .map((p) => ({ id: p.id, similarity: dot(queryEmbedding, p.embedding) }))
    .sort((a, b) => b.similarity - a.similarity);
  if (!scored.length) return null;
  const [best, second] = scored;
  const margin = second ? best.similarity - second.similarity : best.similarity;
  if (best.similarity < minSimilarity || margin < minMargin) return null;
  return { id: best.id, similarity: best.similarity, margin };
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

module.exports = { SUPPORT_INTENTS, detectSupportIntent };
