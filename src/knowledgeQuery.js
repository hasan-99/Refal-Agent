const { redactPersonalData } = require("./ai");
const { detectExplicitLanguageRequest } = require("./language");
const { filterRetrievableEvidence, seedRegister } = require("./factRegister");
const { retrieveKnowledge, anchorQueries, contentTerms } = require("./knowledgeRetrieval");

const CONTEXT_DEPENDENT_KNOWLEDGE_QUESTION = /(?:\b(?:how much|price|cost|fee|what does (?:it|that) include|what(?:'s| is) included|tell me more|more details|and that|what about it)\b|(?:كم|قديش).{0,24}(?:تكلف|سعر|رسوم)|(?:بدي|بدّي|اعطيني|أعطيني).{0,20}تفاصيل|تفاصيل\s*(?:أكثر|اكتر)|شو\s*(?:بيشمل|بتشمل)|(?:πόσο|τιμή|κόστος|χρέωση|πες μου περισσότερα|περισσότερες πληροφορίες|τι περιλαμβάνει))/iu;
// Replies that must never be mined as "the prior topic": they state that the
// turn produced no answer, so treating them as context searches for the
// absence instead of the question. The last three are the technical-failure
// reply (knowledgeSearchUnavailableReply) -- a turn where the search never ran
// carries even less topical signal than one that ran and found nothing.
const NON_CONTEXT_RESPONSES = /(?:ما عندي معلومة معتمدة|لا تتوفر لديّ حالياً|ما عندي سعر معتمد|I don['’]t have approved information|I don['’]t have an approved company formation fee|Δεν έχω εγκεκριμένη|couldn['’]t reach our knowledge base|ما قدرت أوصل لقاعدة المعلومات|Δεν μπόρεσα να συνδεθώ με τη βάση γνώσης)/iu;
const BROAD_KNOWLEDGE_INTENTS = new Set(["company_info", "business_areas", "services", "corporate_services"]);
const PACKAGE_DETAIL_QUESTION = /(?:\b(?:package|formation package|setup package|what does .{0,20} include|what(?:'s| is) included)\b|باقة|شو\s*(?:بتشمل|بيشمل)|ماذا\s*تشمل|πακέτο|τι\s*περιλαμβάνει)/iu;
// The corpus has separate approved topic documents. Retrieve each business
// area before composing a broad answer so one high-ranking document cannot
// crowd out every other area.
const BROAD_SERVICE_FACETS = Object.freeze({
  english: [
    "Cyprus company formation package, company structures and lifecycle",
    "corporate tax Cyprus 15% 2026, IP Box, accounting, VAT and payroll",
    "banking and payment gateways for a Cyprus company, corporate bank account",
    "permanent residency Cyprus investment requirements, family, relocation and Non Dom",
    "buying property in Cyprus, buyer journey, off-plan and completed"
  ],
  arabic: [
    "باقة تأسيس الشركة القبرصية، هياكل الشركات ودورة حياتها",
    "ضريبة الشركات في قبرص، IP Box، المحاسبة، VAT والرواتب",
    "الخدمات المصرفية وبوابات الدفع لشركة قبرصية",
    "الإقامة الدائمة في قبرص بالاستثمار، العائلة والانتقال وNon Dom",
    "شراء عقار في قبرص، عقار على الخارطة أو جاهز"
  ],
  greek: [
    "πακέτο ίδρυσης κυπριακής εταιρείας, εταιρικές δομές και κύκλος ζωής",
    "εταιρικός φόρος στην Κύπρο, IP Box, λογιστική, VAT και μισθοδοσία",
    "τραπεζικές υπηρεσίες και πύλες πληρωμών για κυπριακή εταιρεία",
    "μόνιμη διαμονή στην Κύπρο μέσω επένδυσης, οικογένεια και Non Dom",
    "αγορά ακινήτου στην Κύπρο, υπό κατασκευή ή ολοκληρωμένο"
  ]
});
const BROAD_PROFILE_INTRO = Object.freeze({
  english: "Refalco Group business areas and services: company formation, corporate structuring, tax, accounting, investment, property, development, residency and relocation",
  arabic: "مجالات وخدمات Refalco Group: تأسيس الشركات، الهيكلة، الضرائب، المحاسبة، الاستثمار، العقارات، التطوير، الإقامة والانتقال",
  greek: "τομείς δραστηριότητας και υπηρεσίες του ομίλου Refalco: σύσταση εταιρειών, εταιρική δομή, φορολογία, λογιστική, επενδύσεις, ακίνητα, ανάπτυξη, διαμονή και μετεγκατάσταση"
});
const PACKAGE_TITLE_QUERY = Object.freeze({
  english: "What the Cyprus company formation package includes",
  arabic: "شو بتشمل باقة تأسيس الشركة القبرصية بالضبط",
  greek: "Τι περιλαμβάνει το πακέτο ίδρυσης κυπριακής εταιρείας"
});
function normalizedLanguage(language) {
  const value = String(language || "english").toLowerCase();
  if (["ar", "arabic"].includes(value)) return "arabic";
  if (["el", "greek"].includes(value)) return "greek";
  return "english";
}
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

function buildKnowledgeSearchQueries(currentMessage, user, intents = [], language = "english") {
  const base = buildKnowledgeSearchQuery(currentMessage, user, intents);
  if (!Array.isArray(intents) || !intents.some((intent) => BROAD_KNOWLEDGE_INTENTS.has(intent))) return [base];
  // Keep each query focused: the hybrid and lexical search both lose recall
  // when the customer's whole question is combined with a long facet string.
  const key = normalizedLanguage(language);
  const serviceFacets = BROAD_SERVICE_FACETS[key];
  const facets = intents.includes("company_info")
    ? [BROAD_PROFILE_INTRO[key], ...serviceFacets]
    : intents.includes("business_areas")
      ? [BROAD_PROFILE_INTRO[key], ...serviceFacets]
      : serviceFacets;
  // A specific package question must lead with its own wording so both the
  // model and deterministic fallback see the matching approved package fact
  // first. Broad service questions still fan out across all service facets.
  return PACKAGE_DETAIL_QUESTION.test(base) ? [PACKAGE_TITLE_QUERY[key], base, ...facets] : [...facets];
}

// Round planning. Round 1 is the intent-aware wording this module already
// built. Later rounds exist because step 7 forbids reporting knowledge as
// missing before the question has been asked a DIFFERENT way:
//
//   round 2 -- cross-language concept anchors, so an Arabic colloquial question
//              still has English terms to match a section heading on, plus the
//              exact wordings of whichever question parts came back unsupported
//   round 3 -- the bare content terms, the loosest wording we have
//
// A round is skipped entirely once coverage is met, so the common case still
// costs exactly one round of searches.
// CROSS-REFERENCES, FOLLOWED THROUGH A REAL LINK.
//
// A corpus section's metadata carries `supporting`: the governed fact ids this
// document REFERENCES but does not own (src/corpusIngest.js#sectionFactIds).
// That is a structured cross-reference, not a guess, and the fact register
// holds each id's `claimText`. So a section that leans on a fact owned by
// another topic can pull that topic's own wording into the next search round,
// instead of the answer stopping at the reference.
const FACT_REGISTER = seedRegister();

function crossReferenceQueries(sections = []) {
  const ids = new Set();
  for (const section of sections) {
    const supporting = section?.metadata?.supporting;
    if (Array.isArray(supporting)) for (const id of supporting) ids.add(String(id || "").trim());
  }
  const queries = [];
  for (const id of ids) {
    const claim = FACT_REGISTER.get(id)?.claimText;
    if (claim) queries.push(String(claim).slice(0, 300));
  }
  return queries.slice(0, 3);
}

function planRound(round, { question, language, coverage, baseQueries, sections }) {
  if (round === 1) return baseQueries;
  if (round === 2) {
    const gaps = (coverage?.unsupported || []).map((part) => part.part).filter(Boolean);
    return [
      ...anchorQueries(question),
      ...crossReferenceQueries(sections),
      ...gaps,
      PACKAGE_TITLE_QUERY[normalizedLanguage(language)]
    ];
  }
  const terms = contentTerms(question);
  return terms.length ? [terms.join(" ")] : [];
}

// Retrieval for one conversation turn. The return shape is unchanged for
// existing callers (`evidence`, `queryCount`, `failures`, `complete`) and adds
// `status`, `sections` and `trace`.
//
// `evidence` now carries EVERY ranked section that survived the fact-register
// gate, not the single first row per query that the previous implementation
// kept. See the header of src/knowledgeRetrieval.js for why that one-row
// `.find(...)` was the main cause of "I have no confirmed information" on
// questions the corpus answers.
async function retrieveKnowledgeForTurn(currentMessage, {
  user, intents = [], language = "english", store, embedText, embedQueryTexts, embeddingModel,
  matchCount = 12, limits = {}
} = {}) {
  const baseQueries = buildKnowledgeSearchQueries(currentMessage, user, intents, language);

  const result = await retrieveKnowledge(currentMessage, {
    store, embedQueryTexts, embedText, embeddingModel, language,
    limits: { ...limits, matchCount: Math.max(matchCount, 6) },
    planQueries: (round, context) => planRound(round, { ...context, baseQueries })
  });

  // The fact register is a governance gate, not a ranking signal, so it is
  // applied to the finished evidence set rather than inside the loop. Finding
  // aids (`aliases`) are navigation, never customer evidence.
  const governed = result.evidence.filter((section) => {
    if (String(section.kind || "") === "aliases") return false;
    // The chunk's OWN metadata must reach the gate: factRegister#chunkFactIds
    // reads `metadata.facts`, and passing a synthesized `{ kind }` object would
    // hand it an empty fact list and silently approve a blocked section.
    const metadata = section.metadata && typeof section.metadata === "object"
      ? { ...section.metadata, kind: section.kind ?? section.metadata.kind }
      : { kind: section.kind };
    return filterRetrievableEvidence([{ ...section, metadata }]).kept.length > 0;
  });
  const dropped = result.evidence.length - governed.length;
  if (dropped > 0) result.trace.factRegisterDropped = dropped;

  // Rows in the shape the existing answer path expects.
  const evidence = governed.map((section) => ({
    document_id: section.documentId,
    chunk_id: section.chunkId,
    document_title: section.title,
    source_name: section.sourceName,
    heading: section.heading,
    content: section.content,
    chunk_index: section.chunkIndex,
    chunk_kind: section.kind,
    valid_until: section.validUntil,
    rank: section.rank ?? null
  }));

  const failures = (result.trace.errors || []).filter((entry) => entry.stage !== "sections");
  return {
    evidence,
    sections: governed,
    status: governed.length ? result.status : (result.searchFailed ? "search_failed" : "no_evidence"),
    searchFailed: result.searchFailed,
    coverage: result.coverage.overall,
    conflicts: result.conflicts,
    trace: result.trace,
    queryCount: (result.trace.rounds || []).reduce((sum, round) => sum + round.queries.length, 0),
    failures,
    // `complete` kept for callers that branch on it. A turn is complete when no
    // search errored; a merely low-coverage turn is still a real answer.
    complete: failures.length === 0,
    embeddingMs: null,
    searchMs: result.trace.totalMs
  };
}


module.exports = { buildKnowledgeSearchQuery, buildKnowledgeSearchQueries, retrieveKnowledgeForTurn, planRound, crossReferenceQueries };
