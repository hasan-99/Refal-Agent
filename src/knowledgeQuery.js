const { redactPersonalData } = require("./ai");
const { detectExplicitLanguageRequest } = require("./language");

const CONTEXT_DEPENDENT_KNOWLEDGE_QUESTION = /(?:\b(?:how much|price|cost|fee|what does (?:it|that) include|what(?:'s| is) included|tell me more|more details|and that|what about it)\b|(?:كم|قديش).{0,24}(?:تكلف|سعر|رسوم)|(?:بدي|بدّي|اعطيني|أعطيني).{0,20}تفاصيل|تفاصيل\s*(?:أكثر|اكتر)|شو\s*(?:بيشمل|بتشمل)|(?:πόσο|τιμή|κόστος|χρέωση|πες μου περισσότερα|περισσότερες πληροφορίες|τι περιλαμβάνει))/iu;
const NON_CONTEXT_RESPONSES = /(?:ما عندي معلومة معتمدة|لا تتوفر لديّ حالياً|ما عندي سعر معتمد|I don['’]t have approved information|I don['’]t have an approved company formation fee|Δεν έχω εγκεκριμένη)/iu;
const BROAD_KNOWLEDGE_INTENTS = new Set(["company_info", "business_areas", "services", "corporate_services"]);
const PACKAGE_DETAIL_QUESTION = /(?:\b(?:package|formation package|setup package|what does .{0,20} include|what(?:'s| is) included|what do i get(?:\s+with|\s+if)?|what will i get(?:\s+with|\s+if)?|what is part of)\b|باقة|شو\s*(?:بتشمل|بيشمل|باخد|باخد\s*اذا)|ماذا\s*تشمل|ماذا\s*احصل\s*(?:عليه|عليها)|πακέτο|τι\s*περιλαμβάνει|τι\s*παίρνω(?:\s+αν)?|τι\s+περιλαμβάνει\s+η\s+υπηρεσία)/iu;
// The corpus has separate approved topic documents. Retrieve each business
// area before composing a broad answer so one high-ranking document cannot
// crowd out every other area.
const BROAD_SERVICE_FACETS = Object.freeze({
  english: [
    "Cyprus company formation",
    "Cyprus corporate tax",
    "Cyprus banking and payment gateways",
    "Cyprus permanent residency",
    "Buying property in Cyprus",
    "Landowner partnerships and construction tenders Cyprus",
    "Trademarks shareholder agreements contracts Cyprus"
  ],
  arabic: [
    "تسجيل شركة قبرص",
    "ضريبة الشركات في قبرص",
    "المصرفية وبوابات الدفع لشركة قبرصية",
    "الإقامة الدائمة في قبرص",
    "شراء العقار في قبرص",
    "شراكات ملاك الأراضي ومناقصات الإنشاءات",
    "العلامات التجارية واتفاقيات الشركاء والعقود"
  ],
  greek: [
    "εγγραφή εταιρείας Κύπρος",
    "εταιρικός φόρος στην Κύπρο",
    "τραπεζικοί λογαριασμοί και πύλες πληρωμών για κυπριακή εταιρεία",
    "μόνιμη διαμονή στην Κύπρο",
    "αγορά ακινήτου στην Κύπρο",
    "συνεργασίες ιδιοκτητών γης και κατασκευαστικοί διαγωνισμοί",
    "εμπορικά σήματα συμφωνίες μετόχων συμβάσεις Κύπρος"
  ]
});
const PACKAGE_TITLE_QUERY = Object.freeze({
  english: "What the Cyprus company formation package includes",
  arabic: "شو بتشمل باقة تأسيس الشركة القبرصية بالضبط",
  greek: "Τι περιλαμβάνει το πακέτο ίδρυσης κυπριακής εταιρείας"
});
const COMPANY_PROFILE_QUERY = Object.freeze({
  english: "Not a narrow company registration office",
  arabic: "مو مكتب تسجيل شركات ضيق",
  greek: "Όχι ένα στενό γραφείο εγγραφής εταιρειών"
});
// Give broad questions a small, balanced evidence bundle. Each facet's best
// eligible hit is selected first; only then do we add second-best hits, so one
// search cannot crowd every other service out of the model context.
const MAX_TURN_EVIDENCE_CHUNKS = 8;
const MAX_TURN_EVIDENCE_CHARS = 10000;
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
  // Keep each query short and focused. The lexical RPC requires several query
  // terms to match; a long mixed-domain facet can therefore return no results
  // even when its individual topics are well covered by the corpus.
  const key = normalizedLanguage(language);
  const companyProfileOnly = intents.some((intent) => intent === "company_info" || intent === "business_areas")
    && !intents.some((intent) => intent === "services" || intent === "corporate_services");
  if (companyProfileOnly && !PACKAGE_DETAIL_QUESTION.test(base)) {
    // This approved profile heading retrieves the current business-area claim
    // consistently in EN/AR/EL. Keep customer wording first and cap the
    // targeted fan-out at two queries; approval filtering remains unchanged.
    return [base, COMPANY_PROFILE_QUERY[key]];
  }
  const serviceFacets = BROAD_SERVICE_FACETS[key];
  // The actual customer wording remains the lead query; each facet targets one
  // service area in the requested language rather than combining unrelated
  // topics whose shared terms dilute lexical recall.
  // The canonical package-title query is an empirically reliable anchor in all
  // three corpora. Keep it in the bounded broad fan-out so natural, general
  // company wording does not miss the formation-package document in AR/EL.
  const facets = [PACKAGE_TITLE_QUERY[key], ...serviceFacets.slice(1)];
  // Preserve the customer's exact question in the search fan-out. Replacing it
  // with generic service facets can lose specific intent such as shareholder
  // changes or construction projects. Keep it first so matching evidence is
  // considered before the balanced broad-service results.
  return PACKAGE_DETAIL_QUESTION.test(base) ? [PACKAGE_TITLE_QUERY[key], base] : [base, ...facets];
}

async function retrieveKnowledgeForTurn(currentMessage, {
  user, intents = [], language = "english", store, embedText, embedQueryTexts, embeddingModel, matchCount = 6
} = {}) {
  const queries = buildKnowledgeSearchQueries(currentMessage, user, intents, language);
  const evidence = [];
  const seen = new Set();
  const failures = [];
  let queryEmbeddings = null;
  let embeddingFailure = null;
  const embeddingStartedAt = Date.now();
  if (typeof embedQueryTexts === "function") {
    try {
      queryEmbeddings = await embedQueryTexts(queries);
      if (!Array.isArray(queryEmbeddings) || queryEmbeddings.length !== queries.length) {
        throw new Error("Query embedding batch did not match the knowledge query count.");
      }
    } catch (error) {
      embeddingFailure = error;
    }
  }
  const embeddingMs = Date.now() - embeddingStartedAt;
  const searchStartedAt = Date.now();
  const results = await Promise.all(queries.map(async (query, index) => {
    try {
      if (embeddingFailure) throw embeddingFailure;
      const embedding = queryEmbeddings
        ? queryEmbeddings[index]
        : typeof embedText === "function" ? await embedText(query) : null;
      const rows = typeof store?.searchKnowledge === "function"
        ? await store.searchKnowledge(query, embedding, embeddingModel || null, matchCount)
        : [];
      const eligibleRows = (Array.isArray(rows) ? rows : []).filter((candidate) => {
        const kind = candidate?.chunk_kind ?? candidate?.chunkKind ?? candidate?.metadata?.kind;
        // The search RPC already limits results to active sources and approved,
        // current revisions. All indexed section types are customer evidence;
        // only catalogue/finding-aid chunks are not.
        if (String(kind || "") === "aliases") return false;
        if (candidate?.review_status && candidate.review_status !== "approved") return false;
        return true;
      });
      return { rows: eligibleRows, error: null };
    } catch (error) {
      return { rows: [], error };
    }
  }));
  // Promise.all preserves query order. Select in rounds: one best result per
  // facet first, then additional results in rank order. Deduplicate after all
  // searches finish so concurrent workers never race on the shared Set.
  for (const result of results) {
    if (result.error) failures.push(result.error);
  }
  let evidenceChars = 0;
  const maxRowsPerQuery = Math.max(0, ...results.map((result) => result.rows.length));
  for (let rank = 0; rank < maxRowsPerQuery && evidence.length < MAX_TURN_EVIDENCE_CHUNKS; rank += 1) {
    for (const result of results) {
      const row = result.rows[rank];
      if (!row || evidence.length >= MAX_TURN_EVIDENCE_CHUNKS) continue;
      const key = String(row?.chunk_id || row?.chunkId || [row?.document_id, row?.heading, row?.content].join("|"));
      if (seen.has(key)) continue;
      const chars = String(row?.heading || "").length + String(row?.content || "").length;
      if (evidenceChars + chars > MAX_TURN_EVIDENCE_CHARS) continue;
      seen.add(key);
      evidence.push(row);
      evidenceChars += chars;
    }
  }
  return { evidence, evidenceChars, queryCount: queries.length, failures, complete: failures.length === 0, embeddingMs, searchMs: Date.now() - searchStartedAt };
}


module.exports = { buildKnowledgeSearchQuery, buildKnowledgeSearchQueries, retrieveKnowledgeForTurn, MAX_TURN_EVIDENCE_CHUNKS, MAX_TURN_EVIDENCE_CHARS };
