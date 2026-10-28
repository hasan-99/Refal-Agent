"use strict";

// Labelled calibration data for Knowledge Gap grouping. Evaluation data only:
// nothing here is copied into knowledge content, prompts or intent profiles.
//
// Each topic is one knowledge need asked in several ways and languages
// (positives). Topics are chosen in pairs that share vocabulary but need
// DIFFERENT knowledge (hard negatives), e.g. "change company address" vs
// "change company name" vs "what is your office address". A correct grouping
// keeps every topic together and never merges two topics.
//
// intents: what the contextual classifier plausibly returns for the topic,
// used to derive the category the grouping compatibility rule sees.

const TOPICS = Object.freeze([
  { id: "office_change", intents: ["company_formation"], questions: [
    ["en", "Can I change my company address?"],
    ["ar", "هل أقدر أغير عنوان الشركة؟"],
    ["en", "Can registered office be changed later?"],
    ["en", "Is it possible to move our registered office to a new address after incorporation?"],
    ["el", "Μπορώ να αλλάξω τη διεύθυνση της εταιρείας;"],
    ["ar", "ممكن ننقل مقر الشركة المسجل لعنوان ثاني؟"]
  ] },
  { id: "name_change", intents: ["company_formation"], questions: [
    ["en", "Can I change my company name later?"],
    ["ar", "هل يمكن تغيير اسم الشركة بعد التسجيل؟"],
    ["en", "Is renaming the company possible after registration?"],
    ["el", "Μπορώ να αλλάξω το όνομα της εταιρείας;"]
  ] },
  { id: "refal_office_location", intents: ["contact"], questions: [
    ["en", "Where is your office located?"],
    ["ar", "وين مكتبكم؟"],
    ["en", "What is your office address?"],
    ["el", "Πού βρίσκεται το γραφείο σας;"]
  ] },
  { id: "registration_cost", intents: ["company_formation", "pricing"], questions: [
    ["en", "How much does company registration cost?"],
    ["ar", "كم تكلفة تسجيل الشركة؟"],
    ["en", "What is the price to set up a company?"],
    ["el", "Πόσο κοστίζει η σύσταση εταιρείας;"]
  ] },
  { id: "registration_time", intents: ["company_formation"], questions: [
    ["en", "How long does company registration take?"],
    ["ar", "كم يستغرق تسجيل الشركة؟"],
    ["en", "How many days until my company is registered?"],
    ["el", "Πόσο χρόνο παίρνει η εγγραφή εταιρείας;"]
  ] },
  { id: "refund_cancel", intents: ["pricing"], questions: [
    ["en", "Can I get a refund if I cancel?"],
    ["ar", "هل يمكن استرداد المبلغ إذا ألغيت؟"],
    ["en", "Do you give money back if I change my mind?"],
    ["el", "Μπορώ να πάρω πίσω τα χρήματα αν ακυρώσω;"]
  ] },
  { id: "installments", intents: ["pricing"], questions: [
    ["en", "Can I pay in installments?"],
    ["ar", "هل يمكن الدفع على أقساط؟"],
    ["en", "Is there a payment plan option?"]
  ] },
  { id: "crypto_payment", intents: ["pricing"], questions: [
    ["en", "Can I pay with cryptocurrency?"],
    ["ar", "هل تقبلون الدفع بالعملات الرقمية؟"],
    ["en", "Do you accept bitcoin as payment?"]
  ] },
  { id: "bank_account", intents: ["banking"], questions: [
    ["en", "Can you help me open a corporate bank account?"],
    ["ar", "هل تساعدوني بفتح حساب بنكي للشركة؟"],
    ["en", "Do you assist with opening a business bank account?"]
  ] },
  { id: "property_residency", intents: ["immigration", "real_estate_purchase"], questions: [
    ["en", "Does buying property give me residency?"],
    ["ar", "هل شراء عقار يعطيني إقامة؟"],
    ["en", "Can I get a residence permit by purchasing a house?"],
    ["el", "Αν αγοράσω ακίνητο παίρνω άδεια διαμονής;"]
  ] },
  { id: "tax_residency", intents: ["tax"], questions: [
    ["en", "How do I become a Cyprus tax resident?"],
    ["ar", "كيف أصبح مقيم ضريبي في قبرص؟"],
    ["en", "What is the 60-day rule for tax residency?"]
  ] },
  { id: "vat_registration", intents: ["tax", "vat"], questions: [
    ["en", "Do I need to register for VAT?"],
    ["ar", "هل لازم أسجل في ضريبة القيمة المضافة؟"],
    ["en", "Is VAT registration mandatory for my company?"]
  ] },
  { id: "close_company", intents: ["company_formation"], questions: [
    ["en", "How do I close my company?"],
    ["ar", "كيف أغلق الشركة؟"],
    ["en", "What is the process to strike off a company?"]
  ] },
  { id: "office_hours", intents: ["contact"], questions: [
    ["en", "What are your office opening hours?"],
    ["ar", "متى ساعات الدوام عندكم؟"],
    ["en", "When is your office open?"]
  ] },
  { id: "nominee_director", intents: ["corporate_services"], questions: [
    ["en", "Do you provide nominee directors?"],
    ["en", "Can you supply a nominee shareholder or director?"],
    ["ar", "هل توفرون مدير اسمي للشركة؟"]
  ] }
]);

// HELD-OUT set: written after the aspect lexicon in knowledgeGapPolicy.mjs was
// fixed and never used to tune it or the thresholds. Several topics use words
// the lexicon does not know (deposit, audit, family, online), so this measures
// how the guard generalises, not how well it fits its own design set.
const HELD_OUT_TOPICS = Object.freeze([
  { id: "formation_documents", intents: ["company_formation"], questions: [
    ["en", "What documents do I need to register a company?"],
    ["ar", "ما الأوراق المطلوبة لتأسيس شركة؟"],
    ["en", "Which papers are required to incorporate?"],
    ["el", "Τι έγγραφα χρειάζομαι για να ανοίξω εταιρεία;"]
  ] },
  { id: "remote_formation", intents: ["company_formation"], questions: [
    ["en", "Can I register a company without visiting Cyprus?"],
    ["ar", "هل يمكن تسجيل الشركة بدون ما أسافر لقبرص؟"],
    ["en", "Is it possible to set up the company remotely?"]
  ] },
  { id: "annual_audit", intents: ["accounting"], questions: [
    ["en", "Does my company need an annual audit?"],
    ["ar", "هل الشركة بحاجة لتدقيق سنوي؟"],
    ["en", "Is a yearly audit mandatory?"]
  ] },
  { id: "family_residency", intents: ["immigration"], questions: [
    ["en", "Can my family get residency with me?"],
    ["ar", "هل عائلتي تقدر تاخذ إقامة معي؟"],
    ["en", "Can my wife and children join me on my residence permit?"]
  ] },
  { id: "permit_timing", intents: ["immigration"], questions: [
    ["en", "When will my residence permit be ready?"],
    ["ar", "متى تجهز الإقامة؟"],
    ["en", "How long does the residence permit take to be issued?"]
  ] },
  { id: "rental_tax", intents: ["tax"], questions: [
    ["en", "How is rental income taxed?"],
    ["ar", "كيف تفرض الضريبة على دخل الإيجار؟"],
    ["en", "What tax do I pay on rent from my apartment?"]
  ] },
  { id: "online_meeting", intents: ["appointment"], questions: [
    ["en", "Can we have the consultation online?"],
    ["ar", "ممكن الاستشارة تكون أونلاين؟"],
    ["en", "Do you do video call meetings?"]
  ] },
  { id: "deposit_refund", intents: ["real_estate_purchase"], questions: [
    ["en", "Is the reservation deposit refundable?"],
    ["ar", "هل العربون مسترد؟"],
    ["en", "Will I get my deposit back if I don't buy?"]
  ] },
  { id: "deposit_amount", intents: ["real_estate_purchase"], questions: [
    ["en", "How much is the reservation deposit?"],
    ["ar", "كم قيمة العربون؟"],
    ["en", "What amount do I pay to reserve a property?"]
  ] },
  { id: "replace_director", intents: ["corporate_services"], questions: [
    ["en", "Can I replace a director later?"],
    ["ar", "هل يمكن تغيير مدير الشركة لاحقاً؟"],
    ["en", "How do I appoint a new director?"]
  ] },
  { id: "add_shareholder", intents: ["corporate_services"], questions: [
    ["en", "Can I add a new shareholder?"],
    ["ar", "هل يمكن إضافة شريك جديد للشركة؟"],
    ["en", "How do I transfer shares to another person?"]
  ] }
]);

function flatten(topics) {
  return Object.freeze(topics.flatMap((topic) => topic.questions.map(([lang, text], index) => Object.freeze({
    id: `${topic.id}#${index + 1}`, topic: topic.id, lang, text, intents: topic.intents
  }))));
}

const CALIBRATION_QUESTIONS = flatten(TOPICS);
const HELD_OUT_QUESTIONS = flatten(HELD_OUT_TOPICS);

module.exports = {
  KNOWLEDGE_GAP_CALIBRATION_TOPICS: TOPICS,
  KNOWLEDGE_GAP_CALIBRATION_QUESTIONS: CALIBRATION_QUESTIONS,
  KNOWLEDGE_GAP_HELD_OUT_QUESTIONS: HELD_OUT_QUESTIONS
};
