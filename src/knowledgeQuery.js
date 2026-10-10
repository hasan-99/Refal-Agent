const { redactPersonalData } = require("./ai");
const { detectExplicitLanguageRequest } = require("./language");
const { filterRetrievableEvidence } = require("./factRegister");

const CONTEXT_DEPENDENT_KNOWLEDGE_QUESTION = /(?:\b(?:how much|price|cost|fee|what does (?:it|that) include|what(?:'s| is) included|tell me more|more details|and that|what about it)\b|(?:كم|قديش).{0,24}(?:تكلف|سعر|رسوم)|(?:بدي|بدّي|اعطيني|أعطيني).{0,20}تفاصيل|تفاصيل\s*(?:أكثر|اكتر)|شو\s*(?:بيشمل|بتشمل)|(?:πόσο|τιμή|κόστος|χρέωση|πες μου περισσότερα|περισσότερες πληροφορίες|τι περιλαμβάνει))/iu;
const NON_CONTEXT_RESPONSES = /(?:ما عندي معلومة معتمدة|لا تتوفر لديّ حالياً|ما عندي سعر معتمد|I don['’]t have approved information|I don['’]t have an approved company formation fee|Δεν έχω εγκεκριμένη)/iu;
const BROAD_KNOWLEDGE_INTENTS = new Set(["company_info", "business_areas", "services", "corporate_services"]);
// The corpus has separate approved topic documents. Retrieve each business
// area before composing a broad answer so one high-ranking document cannot
// crowd out every other area.
const BROAD_SERVICE_FACETS = Object.freeze([
  "Cyprus company formation package, company structures and lifecycle",
  "corporate tax Cyprus 15% 2026, IP Box, accounting, VAT and payroll",
  "banking and payment gateways for a Cyprus company, corporate bank account",
  "permanent residency Cyprus investment requirements, family, relocation and Non Dom",
  "buying property in Cyprus, buyer journey, off-plan and completed"
]);
const BROAD_COMPANY_PROFILE_FACETS = Object.freeze([
  "who Refalco Group is, company profile, Cyprus, experience and projects",
  ...BROAD_SERVICE_FACETS.slice(0, 3),
  BROAD_SERVICE_FACETS[4]
]);
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

function buildKnowledgeSearchQueries(currentMessage, user, intents = []) {
  const base = buildKnowledgeSearchQuery(currentMessage, user, intents);
  if (!Array.isArray(intents) || !intents.some((intent) => BROAD_KNOWLEDGE_INTENTS.has(intent))) return [base];
  // Keep each query focused: the hybrid and lexical search both lose recall
  // when the customer's whole question is combined with a long facet string.
  const facets = intents.includes("company_info") ? BROAD_COMPANY_PROFILE_FACETS : BROAD_SERVICE_FACETS;
  return [...facets];
}

async function retrieveKnowledgeForTurn(currentMessage, {
  user, intents = [], store, embedText, embeddingModel, matchCount = 6
} = {}) {
  const queries = buildKnowledgeSearchQueries(currentMessage, user, intents);
  const evidence = [];
  const seen = new Set();
  const failures = [];
  for (const query of queries) {
    try {
      const embedding = typeof embedText === "function" ? await embedText(query) : null;
      const rows = typeof store?.searchKnowledge === "function"
        ? await store.searchKnowledge(query, embedding, embeddingModel || null, matchCount)
        : [];
      const row = (Array.isArray(rows) ? rows : []).find((candidate) => {
        const kind = candidate?.chunk_kind ?? candidate?.chunkKind ?? candidate?.metadata?.kind;
        if (kind && String(kind) !== "fact") return false;
        if (filterRetrievableEvidence([candidate]).kept.length === 0) return false;
        const key = String(candidate?.chunk_id || candidate?.chunkId || [candidate?.document_id, candidate?.heading, candidate?.content].join("|"));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (row) evidence.push(row);
    } catch (error) {
      failures.push(error);
    }
  }
  return { evidence, queryCount: queries.length, failures, complete: failures.length === 0 };
}


module.exports = { buildKnowledgeSearchQuery, buildKnowledgeSearchQueries, retrieveKnowledgeForTurn };
