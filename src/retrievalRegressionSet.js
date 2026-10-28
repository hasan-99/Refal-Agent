"use strict";

// Live retrieval regression set for the approved RAG package
// (`manual:refal-rag-package:<chunk_id>` sources).
//
// Each case: { id, group, lang, query, expected: [chunk ids], primary? }
//   expected  any of these chunks counts as a hit; the reported rank is the
//             best-ranked one.
//   primary   the chunk that carries the canonical answer, reported on its own
//             so a sibling FAQ chunk cannot hide a regression in it.
//
// The paraphrase groups deliberately use dialect, spelling and structure that
// share few or no words with the chunk text. They are evaluation data only:
// nothing here is copied into knowledge content or into the intent profiles
// in src/knowledgeRerank.js, so a pass measures meaning, not word overlap.

const SET = Object.freeze([
  // --- guarantee / approval (required paraphrases) ---------------------------
  ["G01", "guarantee", "ar", "هل تضمنون تسجيل الشركة؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G02", "guarantee", "ar", "هل تسجيل الشركة مضمون؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G03", "guarantee", "ar", "هل أكيد الشركة تنسجل؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G04", "guarantee", "ar", "شو بصير إذا رفضوا تسجيل الشركة؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G05", "guarantee", "ar", "هل ممكن طلب تأسيس الشركة ينرفض؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G06", "guarantee", "ar", "في ضمان إن الشركة تنفتح؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G07", "guarantee", "ar", "بتضمنولي الموافقة على الشركة؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G08", "guarantee", "en", "Is company registration guaranteed?", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G09", "guarantee", "en", "Do you guarantee the company will be approved?", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G10", "guarantee", "en", "Can my company registration be rejected?", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G11", "guarantee", "en", "What happens if incorporation is not approved?", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G12", "guarantee", "en", "Is approval guaranteed?", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  // held-out dialects
  ["G13", "guarantee", "ar", "لو الشركة اترفضت هتعملوا إيه؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G14", "guarantee", "ar", "واش كاين ضمان باش تتقبل الشركة ديالي؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["G15", "guarantee", "ar", "اذا ما وافقوا على الشركة وش يصير بفلوسي؟", ["RF-KB-045", "RF-KB-038", "RF-KB-042"], "RF-KB-045"],

  // --- refund / cancellation --------------------------------------------------
  ["R01", "refund", "ar", "هل يمكنني استرداد المبلغ إذا ألغيت الطلب؟", ["RF-KB-042"]],
  ["R02", "refund", "ar", "بترجعولي المصاري إذا غيرت رأيي؟", ["RF-KB-042"]],
  ["R03", "refund", "ar", "لو لغيت الطلب الفلوس بترجع؟", ["RF-KB-042"]],
  ["R04", "refund", "ar", "المبلغ اللي دفعته ينرد لو تراجعت؟", ["RF-KB-042"]],
  ["R05", "refund", "en", "Can I get a refund if I cancel?", ["RF-KB-042"]],
  ["R06", "refund", "en", "Is the fee refundable if I change my mind?", ["RF-KB-042"]],

  // --- complaints -------------------------------------------------------------
  ["C01", "complaint", "ar", "أريد تقديم شكوى", ["RF-KB-043"]],
  ["C02", "complaint", "ar", "أنا مش راضي عن الخدمة، لمين أحكي؟", ["RF-KB-043"]],
  ["C03", "complaint", "ar", "عندي مشكلة مع الموظف وبدي أصعّد الموضوع", ["RF-KB-043"]],
  ["C04", "complaint", "en", "I want to file a complaint", ["RF-KB-043"]],
  ["C05", "complaint", "en", "I'm unhappy with how my case was handled, who can I escalate to?", ["RF-KB-043"]],

  // --- tax advice (referral) --------------------------------------------------
  ["T01", "tax_advice", "ar", "أحتاج استشارة ضريبية", ["RF-KB-043"]],
  ["T02", "tax_advice", "ar", "بدي حدا يفهمني وضعي الضريبي", ["RF-KB-043"]],
  ["T03", "tax_advice", "en", "Can someone advise me on my tax situation?", ["RF-KB-043"]],
  ["T04", "tax_advice", "en", "Do you have an accountant who can help with my taxes?", ["RF-KB-043"]],

  // --- payment ----------------------------------------------------------------
  ["P01", "payment", "ar", "كيف أدفع؟ هل هناك دفعة مقدمة؟", ["RF-KB-042"]],
  ["P02", "payment", "ar", "ينفع أقسط المبلغ؟", ["RF-KB-042"]],
  ["P03", "payment", "ar", "وين بحول المصاري؟", ["RF-KB-042"]],
  ["P04", "payment", "en", "How do I pay?", ["RF-KB-042"]],
  ["P05", "payment", "en", "Can I pay in instalments?", ["RF-KB-042"]],

  // --- government fees --------------------------------------------------------
  ["F01", "gov_fees", "ar", "كم الرسوم الحكومية لتسجيل الشركة؟", ["CY-REG-015"]],
  ["F02", "gov_fees", "ar", "قديش بتاخد الدولة رسوم على فتح الشركة؟", ["CY-REG-015"]],
  ["F03", "gov_fees", "en", "What does the registrar charge to incorporate?", ["CY-REG-015"]],

  // --- timelines --------------------------------------------------------------
  ["L01", "timeline", "ar", "كم يوم يستغرق تأسيس الشركة؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["L02", "timeline", "ar", "امتى الشركة تخلص؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["L03", "timeline", "ar", "قديش بدها وقت لتطلع الشركة؟", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],
  ["L04", "timeline", "en", "How soon will my company be ready?", ["RF-KB-045", "RF-KB-038"], "RF-KB-045"],

  // --- required documents -----------------------------------------------------
  ["D01", "documents", "ar", "شو الأوراق المطلوبة لفتح الشركة؟", ["RF-KB-045", "CY-REG-012"]],
  ["D02", "documents", "ar", "ايش المستندات اللي تحتاجونها مني؟", ["RF-KB-045", "CY-REG-012"]],
  ["D03", "documents", "en", "What paperwork do I need to send you?", ["RF-KB-045", "CY-REG-012"]],

  // --- 2026-10-27 services import set (S1..S16, 18 queries) ------------------
  ["S1a", "services", "ar", "كم سعر تأسيس شركة في قبرص لديكم؟", ["RF-KB-003", "RF-KB-041", "RF-KB-038"]],
  ["S1b", "services", "en", "How much does company formation cost with you?", ["RF-KB-003", "RF-KB-041", "RF-KB-038"]],
  ["S2", "services", "ar", "ماذا يشمل عرض 999 يورو؟ هل يشمل العنوان المسجل والسكرتارية؟", ["RF-KB-041"]],
  ["S3", "services", "ar", "كم تكلفة الخدمات السنوية للشركة بعد التأسيس؟", ["CY-REG-030", "RF-KB-003", "RF-KB-041"]],
  ["S4", "services", "ar", "كم يوم يستغرق تأسيس الشركة؟", ["RF-KB-045", "RF-KB-038"]],
  ["S5", "services", "ar", "هل أستطيع تأسيس الشركة عن بعد بدون سفر؟", ["RF-KB-045", "RF-KB-038"]],
  ["S6", "services", "ar", "هل تضمنون تسجيل الشركة؟", ["RF-KB-045", "RF-KB-038"]],
  ["S7a", "services", "ar", "هل يمكنني استرداد المبلغ إذا ألغيت الطلب؟", ["RF-KB-042"]],
  ["S7b", "services", "en", "Can I get a refund if I cancel?", ["RF-KB-042"]],
  ["S8", "services", "ar", "كيف أدفع؟ هل هناك دفعة مقدمة؟", ["RF-KB-042"]],
  ["S9", "services", "ar", "أنا من سوريا، هل يمكنني تأسيس شركة معكم؟", ["RF-KB-044"]],
  ["S10", "services", "ar", "أريد تقديم شكوى", ["RF-KB-043"]],
  ["S11", "services", "ar", "أين أرسل جواز السفر وإثبات العنوان؟", ["RF-KB-037", "RF-KB-045"]],
  ["S12", "services", "ar", "ما هو موقعكم الرسمي ورقم الواتساب وساعات العمل؟", ["RF-KB-002"]],
  ["S13", "services", "ar", "هل تؤسسون شركات في الإمارات أو بريطانيا؟", ["RF-KB-001", "RF-KB-044"]],
  ["S14", "services", "ar", "هل يشمل السعر فتح حساب بنكي والإقامة؟", ["RF-KB-041", "RF-KB-003"]],
  ["S15", "services", "ar", "أحتاج استشارة ضريبية", ["RF-KB-043"]],
  ["S16", "services", "ar", "كم الرسوم الحكومية لتسجيل الشركة؟", ["CY-REG-015"]],

  // --- 2026-10-26 package import set (general Cyprus knowledge) ----------------
  // R5/R10 also accept RF-KB-045, which now carries the formation timeline.
  ["K01a", "general", "en", "Can a foreigner open a company in Cyprus?", ["CY-REG-004", "CY-REG-035"]],
  ["K01b", "general", "ar", "هل يستطيع الأجنبي تأسيس شركة في قبرص؟", ["CY-REG-004", "CY-REG-035"]],
  ["K02a", "general", "en", "Do I need a local shareholder?", ["CY-REG-004", "CY-REG-003"]],
  ["K02b", "general", "ar", "هل أحتاج إلى مساهم محلي قبرصي؟", ["CY-REG-004", "CY-REG-003"]],
  ["K03a", "general", "en", "What is the minimum capital for a private Cyprus company?", ["CY-REG-007"]],
  ["K03b", "general", "ar", "ما الحد الأدنى لرأس مال الشركة الخاصة في قبرص؟", ["CY-REG-007"]],
  ["K05a", "general", "en", "Can the Cyprus company registration process be completed remotely?", ["CY-REG-016", "RF-KB-038", "RF-KB-045"]],
  ["K05b", "general", "ar", "هل يمكن تسجيل الشركة في قبرص عن بعد دون السفر؟", ["CY-REG-016", "RF-KB-038", "RF-KB-045"]],
  ["K06a", "general", "en", "Does registering a Cyprus company guarantee that a bank will open an account?", ["CY-REG-026"]],
  ["K06b", "general", "ar", "هل تسجيل الشركة يضمن أن البنك سيفتح حساباً؟", ["CY-REG-026"]],
  ["K07a", "general", "en", "What is the Cyprus corporate tax rate in 2026?", ["CY-REG-024"]],
  ["K07b", "general", "ar", "ضريبة دخل الشركات في قبرص 2026", ["CY-REG-024"]],
  ["K08a", "general", "en", "Does opening a Cyprus company automatically give me residency?", ["CY-REG-036", "RF-KB-039", "RF-KB-021"]],
  ["K08b", "general", "ar", "هل تأسيس شركة في قبرص يمنحني الإقامة تلقائياً؟", ["CY-REG-036", "RF-KB-039", "RF-KB-021"]],
  ["K09a", "general", "en", "What documents are normally required from shareholders?", ["CY-REG-012", "CY-REG-013"]],
  ["K09b", "general", "ar", "ما المستندات المطلوبة عادة من المساهمين؟", ["CY-REG-012", "CY-REG-013"]],
  ["K10a", "general", "en", "How long does company registration take?", ["CY-REG-016", "RF-KB-038", "RF-KB-045"]],
  ["K10b", "general", "ar", "كم تستغرق مدة تسجيل الشركة؟", ["CY-REG-016", "RF-KB-038", "RF-KB-045"]],
  ["K11", "general", "ar", "فتح حساب بنكي للشركة", ["CY-REG-026", "CY-REG-027"]],
  ["K12", "general", "ar", "هل شراء عقار يعطيني إقامة؟", ["RF-KB-027", "RF-KB-033", "RF-KB-039"]],
  ["K13a", "general", "en", "Who is Refal / Refalco?", ["RF-KB-001"]],
  ["K13b", "general", "ar", "من هي شركة Refalco؟", ["RF-KB-001"]],
  ["K14", "general", "en", "What approved contact information is available for Refalco?", ["RF-KB-002"]],
  ["K15", "general", "en", "What services does Refalco provide?", ["RF-KB-003"]]
].map(([id, group, lang, query, expected, primary]) => Object.freeze({
  id, group, lang, query, expected: Object.freeze(expected), primary: primary || null
})));

module.exports = { RETRIEVAL_REGRESSION_SET: SET };
