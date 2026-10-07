const { redactPersonalData } = require("./ai");
const { detectExplicitLanguageRequest, detectMessageLanguage } = require("./language");

const CONTEXT_DEPENDENT_KNOWLEDGE_QUESTION = /(?:\b(?:how much|price|cost|fee|what does (?:it|that) include|what(?:'s| is) included|tell me more|more details|and that|what about it)\b|(?:كم|قديش).{0,24}(?:تكلف|سعر|رسوم)|(?:بدي|بدّي|اعطيني|أعطيني).{0,20}تفاصيل|تفاصيل\s*(?:أكثر|اكتر)|شو\s*(?:بيشمل|بتشمل)|(?:πόσο|τιμή|κόστος|χρέωση|πες μου περισσότερα|περισσότερες πληροφορίες|τι περιλαμβάνει))/iu;
const NON_CONTEXT_RESPONSES = /(?:ما عندي معلومة معتمدة|لا تتوفر لديّ حالياً|ما عندي سعر معتمد|I don['’]t have approved information|I don['’]t have an approved company formation fee|Δεν έχω εγκεκριμένη)/iu;
const COMPANY_FORMATION_TOPIC = /\b(?:company|business) (?:formation|setup|registration|incorporation)\b|(?:تسجيل|تأسيس|إنشاء)\s+(?:شركة|شركات)|شركة\s+بقبرص|(?:σύσταση|ίδρυση|εγγραφή)\s+εταιρε(?:ίας|ιών)/iu;
const CANONICAL_SERVICES_QUERY = Object.freeze({
  english: "REFALCO Complete Services Catalog services business areas development infrastructure execution operations technology systems strategic assets Cyprus company formation package price VAT inclusions timing",
  arabic: "دليل خدمات ريفالكو الكامل خدمات ريفالكو مجالات العمل التطوير البنية التحتية التنفيذ العمليات التكنولوجيا الأصول الاستراتيجية تأسيس الشركات في قبرص السعر الباقة ضريبة القيمة المضافة المشمول المدة",
  greek: "Κατάλογος Υπηρεσιών REFALCO υπηρεσίες επιχειρηματικοί τομείς ανάπτυξη υποδομές εκτέλεση λειτουργίες τεχνολογικά συστήματα στρατηγικά περιουσιακά στοιχεία σύσταση εταιρείας τιμή ΦΠΑ πακέτο χρόνος"
});
const FORMATION_DETAIL_FOCUS = Object.freeze({
  english: "REFALCO Complete Services Catalog detailed Cyprus company registration and formation service process required documents remote handling package price VAT inclusions timing conditions",
  arabic: "دليل خدمات ريفالكو تفاصيل خدمة تسجيل وتأسيس الشركات في قبرص الخطوات الوثائق المطلوبة عن بعد السعر الباقة ضريبة القيمة المضافة المشمول المدة الشروط",
  greek: "Κατάλογος Υπηρεσιών REFALCO αναλυτικές πληροφορίες εγγραφή και σύσταση εταιρείας στην Κύπρο διαδικασία δικαιολογητικά εξ αποστάσεως τιμή ΦΠΑ πακέτο χρόνος όροι"
});

function buildKnowledgeSearchQuery(currentMessage, user, intents = []) {
  const current = redactPersonalData(String(currentMessage || "").trim()).slice(0, 1000);
  const language = detectMessageLanguage(current);
  if (Array.isArray(intents) && intents.some((intent) => intent === "services" || intent === "business_areas")) {
    return CANONICAL_SERVICES_QUERY[language] || CANONICAL_SERVICES_QUERY.english;
  }
  if (!current || current.length > 140 || !CONTEXT_DEPENDENT_KNOWLEDGE_QUESTION.test(current)) return current;

  const history = Array.isArray(user?.history) ? user.history : [];
  const priorTopic = [...history].reverse().find((turn) => {
    const message = String(turn?.message || "").trim();
    const response = String(turn?.response || "").trim();
    if (!message || !response || detectExplicitLanguageRequest(message)) return false;
    if (/^(?:hi|hello|hey|مرحبا|مرحباً|أهلا|اهلا|شكرا|شكرًا|thanks|thank you|γεια|ευχαριστώ)[؟?!.،\s]*$/iu.test(message)) return false;
    return !NON_CONTEXT_RESPONSES.test(response);
  });
  if (!priorTopic) return current;

  const priorMessage = redactPersonalData(priorTopic.message).slice(0, 240);
  const priorResponse = redactPersonalData(priorTopic.response).slice(0, 700);
  // Once the prior turn establishes company formation, search the approved
  // concept directly. Mixing a short "more details" phrase with a long prior
  // reply overweights conversational style documents instead of factual data.
  if (COMPANY_FORMATION_TOPIC.test(`${priorMessage}\n${priorResponse}`)) {
    return FORMATION_DETAIL_FOCUS[language] || FORMATION_DETAIL_FOCUS.english;
  }
  return `${current}\nRelevant prior topic: ${priorMessage}\n${priorResponse}`.slice(0, 1800);
}

function isCanonicalServiceQuery(query) {
  return [...Object.values(CANONICAL_SERVICES_QUERY), ...Object.values(FORMATION_DETAIL_FOCUS)].includes(String(query || ""));
}

function buildServiceSupplementQuery(query, language) {
  if (!Object.values(CANONICAL_SERVICES_QUERY).includes(String(query || ""))) return null;
  return FORMATION_DETAIL_FOCUS[language] || FORMATION_DETAIL_FOCUS.english;
}

function prioritizeCanonicalServiceEvidence(evidence, language) {
  if (!Array.isArray(evidence)) return [];
  const languageMatches = (item) => {
    const text = `${item?.heading || ""}\n${item?.content || ""}`;
    if (language === "arabic") return /[\u0600-\u06ff]/u.test(text);
    if (language === "greek") return /[\u0370-\u03ff]/u.test(text) && !/[\u0600-\u06ff]/u.test(text);
    return !/[\u0600-\u06ff\u0370-\u03ff]/u.test(text);
  };
  return evidence.map((item, index) => ({ item, index })).sort((left, right) => {
    const score = ({ item }) => {
      const canonical = item?.source_name === "REFALCO Complete Services Catalog";
      if (canonical && languageMatches(item)) return 0;
      if (canonical) return 1;
      return 2;
    };
    return score(left) - score(right) || left.index - right.index;
  }).map(({ item }) => item);
}

module.exports = { buildKnowledgeSearchQuery, buildServiceSupplementQuery, isCanonicalServiceQuery, prioritizeCanonicalServiceEvidence };
