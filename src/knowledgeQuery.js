const { redactPersonalData } = require("./ai");
const { detectExplicitLanguageRequest } = require("./language");

const CONTEXT_DEPENDENT_KNOWLEDGE_QUESTION = /(?:\b(?:how much|price|cost|fee|what does (?:it|that) include|what(?:'s| is) included|tell me more|more details|and that|what about it)\b|(?:كم|قديش).{0,24}(?:تكلف|سعر|رسوم)|(?:بدي|بدّي|اعطيني|أعطيني).{0,20}تفاصيل|تفاصيل\s*(?:أكثر|اكتر)|شو\s*(?:بيشمل|بتشمل)|(?:πόσο|τιμή|κόστος|χρέωση|πες μου περισσότερα|περισσότερες πληροφορίες|τι περιλαμβάνει))/iu;
const NON_CONTEXT_RESPONSES = /(?:ما عندي معلومة معتمدة|لا تتوفر لديّ حالياً|ما عندي سعر معتمد|I don['’]t have approved information|I don['’]t have an approved company formation fee|Δεν έχω εγκεκριμένη)/iu;
function buildKnowledgeSearchQuery(currentMessage, user, intents = []) {
  const current = redactPersonalData(String(currentMessage || "").trim()).slice(0, 1000);
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
  return `${current}\nRelevant prior topic: ${priorMessage}\n${priorResponse}`.slice(0, 1800);
}


module.exports = { buildKnowledgeSearchQuery };
