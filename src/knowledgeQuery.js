const { redactPersonalData } = require("./ai");
const { detectExplicitLanguageRequest } = require("./language");
const { INTENTS } = require("./intent");

// A greeting has no knowledge need. "كيفك" is a social move, not a question,
// and there is no fact in the corpus that answers it.
//
// Retrieving anyway is actively harmful, not merely wasteful. The hybrid path
// has no "return nothing" behaviour (CF-09): the semantic branch admits
// anything within 0.65 cosine distance and the fusion then returns the top N
// regardless. So a contentless social message still drags back the N chunks
// that happen to sit closest, and the model is handed irrelevant evidence as
// though it were the answer. That is the same failure mode as CF-04, arriving
// through a different door.
//
// Skipping retrieval does NOT make her mute, and it does not hardcode a reply.
// Identity, persona, roles and humour live in the prompt (M1, P1.1-P1.3) and
// are not evidence-gated; only company FACTS are. So with no evidence she can
// still greet warmly, say who she works for and ask what the customer needs.
// She composes it herself. What she cannot do is state a number, which is
// exactly right for "كيفك".
//
// Deliberately narrow: UNKNOWN is NOT treated as social. An unclassified
// message is usually a real question we failed to label, and suppressing
// retrieval there would turn a classifier miss into a knowledge blackout.
const SOCIAL_ONLY_INTENTS = new Set([INTENTS.GREETING, INTENTS.SMALL_TALK]);

function turnNeedsKnowledge(intents = []) {
  const list = Array.isArray(intents) ? intents.filter(Boolean) : [];
  if (!list.length) return true;
  return !list.every((intent) => SOCIAL_ONLY_INTENTS.has(intent));
}

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


module.exports = { buildKnowledgeSearchQuery, turnNeedsKnowledge, SOCIAL_ONLY_INTENTS };
