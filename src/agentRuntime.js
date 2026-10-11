// REFAL-AGENT-007 — the real, callable (but not yet live) integration point
// for one Agent turn: wires the actual embedding function and a real store
// into the Ticket 001-006 tool registry and the Ticket 003-005 loop, driven
// by the Ticket 004 model decision step.
//
// src/bot.js invokes this after deterministic preflight and before the
// shared output, grounding, consent, and persistence gates complete the turn.

const { buildAgentContext } = require("./agentContext");
const { runAgentTurn, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { decideNextStep: defaultDecideNextStep, formatApprovedKnowledgeEvidence } = require("./agentDecision");
const { TOOL_REGISTRY, MAX_RAG_EVIDENCE_ITEMS, MAX_RAG_EVIDENCE_TOTAL_CHARS } = require("./agentTools");
const { embedText: defaultEmbedText, DEFAULT_EMBEDDING_MODEL, redactPersonalData } = require("./ai");
const { detectIntent, INTENTS } = require("./intent");
const { validateResponse, MODEL_DRAFT_THRESHOLDS } = require("./responsePolicy");
const { noApprovedEvidenceReply } = require("./refalcoAnswer");

// Factual customer questions must not depend on the model remembering to ask
// for its evidence first. Retrieve approved knowledge deterministically for
// these routed intents, then let the Agent reason over that bounded result.
const KNOWLEDGE_REQUIRED_INTENTS = new Set([
  INTENTS.COMPANY_INFO, INTENTS.BUSINESS_AREAS, INTENTS.PRICING, INTENTS.SERVICES,
  INTENTS.CONTACT, INTENTS.COMPANY_FORMATION, INTENTS.ACCOUNTING, INTENTS.VAT,
  INTENTS.CYPRUS_BUSINESS_EXPANSION, INTENTS.BUSINESS_RELOCATION, INTENTS.RESIDENCY_ENQUIRY,
  INTENTS.REAL_ESTATE_PURCHASE, INTENTS.REAL_ESTATE_INVESTMENT, INTENTS.LAND_OWNER,
  INTENTS.PROPERTY_DEVELOPMENT, INTENTS.CONSTRUCTION_TENDER, INTENTS.PROJECT_MANAGEMENT,
  INTENTS.INVESTMENT_OPPORTUNITY, INTENTS.INVESTMENT_PARTNERSHIP, INTENTS.STRATEGIC_PARTNERSHIP,
  INTENTS.INFRASTRUCTURE, INTENTS.TECHNOLOGY, INTENTS.OPERATIONS, INTENTS.STRATEGIC_ASSETS,
  INTENTS.BUSINESS_PROPOSAL, INTENTS.PROJECT_ENQUIRY, INTENTS.GENERAL_INFORMATION,
  INTENTS.REAL_ESTATE, INTENTS.LAND_DEVELOPMENT, INTENTS.CONSTRUCTION,
  INTENTS.CORPORATE_SERVICES, INTENTS.INVESTMENT, INTENTS.PARTNERSHIP
]);
const BROAD_COMPANY_INTENTS = new Set([
  INTENTS.COMPANY_INFO, INTENTS.BUSINESS_AREAS, INTENTS.SERVICES, INTENTS.CORPORATE_SERVICES
]);
const SPECIALIZED_SERVICE_INTENTS = new Set([
  INTENTS.PRICING, INTENTS.COMPANY_FORMATION, INTENTS.ACCOUNTING, INTENTS.VAT,
  INTENTS.CYPRUS_BUSINESS_EXPANSION, INTENTS.BUSINESS_RELOCATION, INTENTS.RESIDENCY_ENQUIRY,
  INTENTS.REAL_ESTATE_PURCHASE, INTENTS.REAL_ESTATE_INVESTMENT, INTENTS.LAND_OWNER,
  INTENTS.PROPERTY_DEVELOPMENT, INTENTS.CONSTRUCTION_TENDER, INTENTS.PROJECT_MANAGEMENT,
  INTENTS.INVESTMENT_OPPORTUNITY, INTENTS.INVESTMENT_PARTNERSHIP, INTENTS.STRATEGIC_PARTNERSHIP,
  INTENTS.INFRASTRUCTURE, INTENTS.TECHNOLOGY, INTENTS.OPERATIONS, INTENTS.STRATEGIC_ASSETS,
  INTENTS.BUSINESS_PROPOSAL, INTENTS.PROJECT_ENQUIRY, INTENTS.REAL_ESTATE,
  INTENTS.LAND_DEVELOPMENT, INTENTS.CONSTRUCTION, INTENTS.INVESTMENT, INTENTS.PARTNERSHIP
]);
const BROAD_SERVICE_FOLLOWUPS = Object.freeze({
  en: "Which area would you like to hear more about?",
  ar: "أي مجال حابب تعرف عنه أكثر؟",
  el: "Ποιον τομέα θα θέλατε να μάθετε καλύτερα;"
});
const KNOWN_KNOWLEDGE_TOPIC_TERMS = /\b(?:(?:company\s+(?:formation|setup)|formation\s+package|company\s+services|business\s+services|property\s+purchase|permanent\s+residency|corporate\s+tax)|(?:form|set\s+up|start|establish)(?:ing)?\s+(?:a\s+)?company|(?:set\s+up|start|establish)(?:ing)?\s+(?:a\s+)?business)\b|تأسيس.{0,40}شركة|شركة.{0,40}(?:تأسيس|قبرص)|باقة.{0,40}تأسيس|العقار|الإقامة الدائمة|ضريبة الشركات|πακέτο.{0,40}σύστασης|σύσταση.{0,40}εταιρεί|(?:ίδρυσ|ιδρυσ|ιδρύσ)[\p{L}]*\s+εταιρεί|εταιρικ.{0,30}υπηρεσί|αγορά.{0,30}ακινήτ|μόνιμη διαμονή|εταιρικ.{0,20}φόρ/iu;
// A broad services question needs more than one nearest-neighbour sample.
// Search the approved corpus along three customer-useful facets before the
// first model decision, while keeping every observation under the tool's
// existing evidence budget.
const BROAD_COMPANY_RETRIEVAL = Object.freeze({
  en: {
    overview: "Refalco Group company overview: company formation and structuring, tax and accounting, investment, real estate and property development, comprehensive investment and structural solutions.",
    facets: [
      "Cyprus company formation, lifecycle and legal structure: company structures, name reservation, secretary, registered office, shareholders, directors, ownership changes, dormant company, closure, contracts, intellectual property and GDPR",
      "Cyprus business tax and operations: corporate tax, IP Box, dividends versus salary, holding versus trading, VAT, EORI and payroll",
      "Cyprus company banking and payment gateways: corporate bank account, KYC, AML, Stripe and PayPal",
      "Cyprus residency and relocation: permanent residency, non-dom, source of funds, source of wealth, relocation checklist, schools and healthcare",
      "Cyprus property purchase: buyer journey, off-plan versus completed property, property VAT and cities",
      "Cyprus landowners, development and construction: land development, partnership, planning permits, density, tenders and BOQ",
      "Jurisdiction comparison: Cyprus compared with Dubai, Estonia, Malta, Bulgaria and USA for company setup and operations",
      "Refalco Group company profile, identity and approved track record"
    ]
  },
  ar: {
    overview: "نبذة عن مجموعة Refalco: تأسيس الشركات وهيكلتها، الضرائب والمحاسبة، الاستثمار، العقارات والتطوير، والحلول الاستثمارية والهيكلية.",
    facets: [
      "تأسيس الشركات في قبرص ودورة حياتها وهيكلها القانوني: الهياكل، حجز الاسم، أمين السر، العنوان المسجل، المساهمون والمديرون، تغييرات الملكية، الشركة غير النشطة والإغلاق، العقود والملكية الفكرية وحماية البيانات",
      "ضرائب الشركات والعمليات في قبرص: ضريبة الشركات، IP Box، الأرباح مقابل الراتب، شركة قابضة أو تجارية، VAT وEORI والرواتب",
      "الخدمات المصرفية وبوابات الدفع للشركات القبرصية: حساب شركة، KYC، AML، Stripe وPayPal",
      "الإقامة والانتقال إلى قبرص: الإقامة الدائمة، Non Dom، مصدر الأموال والثروة، قائمة الانتقال، المدارس والرعاية الصحية",
      "شراء العقارات في قبرص: رحلة المشتري، العقارات على الخارطة أو الجاهزة، VAT العقارات والمدن",
      "ملاك الأراضي والتطوير والبناء في قبرص: تطوير الأراضي والشراكة والتخطيط وكثافة البناء والمناقصات وجداول الكميات",
      "مقارنة الولايات القضائية: قبرص مقارنة بدبي وإستونيا ومالطا وبلغاريا والولايات المتحدة لتأسيس الشركات وتشغيلها",
      "نبذة وهوية مجموعة Refalco وسجلها المعتمد"
    ]
  },
  el: {
    overview: "Επισκόπηση του ομίλου Refalco: σύσταση και δομή εταιρειών, φορολογία και λογιστική, επενδύσεις, ακίνητα και ανάπτυξη ακινήτων, ολοκληρωμένες επενδυτικές και δομικές λύσεις.",
    facets: [
      "Σύσταση εταιρείας στην Κύπρο, κύκλος ζωής και νομική δομή: εταιρικές μορφές, κράτηση ονόματος, γραμματέας, εγγεγραμμένο γραφείο, μέτοχοι και διευθυντές, αλλαγές ιδιοκτησίας, αδρανής εταιρεία και κλείσιμο, συμβάσεις και πνευματική ιδιοκτησία",
      "Φορολογία επιχειρήσεων και λειτουργία στην Κύπρο: εταιρικός φόρος, IP Box, μέρισμα έναντι μισθού, εταιρεία συμμετοχών ή εμπορική, VAT, EORI και μισθοδοσία",
      "Τραπεζικές υπηρεσίες και πύλες πληρωμών για κυπριακές εταιρείες: εταιρικός λογαριασμός, KYC, AML, Stripe και PayPal",
      "Διαμονή και μετεγκατάσταση στην Κύπρο: μόνιμη άδεια διαμονής, Non Dom, προέλευση κεφαλαίων και περιουσίας, λίστα μετεγκατάστασης, σχολεία και υγειονομική περίθαλψη",
      "Αγορά ακινήτου στην Κύπρο: διαδρομή αγοραστή, υπό κατασκευή ή ολοκληρωμένο ακίνητο, VAT ακινήτων και πόλεις",
      "Ιδιοκτήτες γης, ανάπτυξη και κατασκευές στην Κύπρο: ανάπτυξη γης, συνεργασία, πολεοδομία, συντελεστής δόμησης, διαγωνισμοί και προμετρήσεις",
      "Σύγκριση δικαιοδοσιών: Κύπρος έναντι Ντουμπάι, Εσθονίας, Μάλτας, Βουλγαρίας και ΗΠΑ για σύσταση και λειτουργία εταιρείας",
      "Προφίλ, ταυτότητα και εγκεκριμένο ιστορικό του ομίλου Refalco"
    ]
  }
});
const MAX_INITIAL_EVIDENCE_CHARS = MAX_RAG_EVIDENCE_TOTAL_CHARS;

function mergeBroadFacetEvidence(observations) {
  const selectedKeys = new Set();
  const allUniqueKeys = new Set();
  let truncated = false;
  let retrievalFailures = 0;
  const facets = observations.map((observation) => {
    const result = observation?.result || {};
    const model = result.modelObservation || {};
    const evidence = Array.isArray(model.evidence) ? model.evidence : [];
    const policyByRef = new Map((model.policyEvidence || []).map((item, index) => [
      item?.sourceRef || `index:${index}`, item
    ]));
    const factRows = new Map((model.factRegisterRows || []).filter((row) => row?.id).map((row) => [row.id, row]));
    truncated ||= Boolean(model.truncated);
    if (result.status === "error" || result.ok === false) retrievalFailures += 1;
    return evidence.flatMap((item, index) => {
      const sourceRef = typeof item?.sourceRef === "string" && item.sourceRef ? item.sourceRef : null;
      const fallback = [item?.title, item?.section, item?.content].map((value) => String(value || "")).join("\u0000");
      const key = sourceRef ? `ref:${sourceRef}` : `content:${fallback}`;
      allUniqueKeys.add(key);
      const policy = policyByRef.get(sourceRef || `index:${index}`) || {};
      const registerRows = (policy.metadata?.facts || []).map((id) => factRows.get(id)).filter(Boolean);
      return [{ item, policy, key, registerRows }];
    });
  });

  const selected = [];
  let usedChars = 0;
  let stop = false;
  for (let rank = 0; !stop; rank += 1) {
    let foundAtRank = false;
    for (const facet of facets) {
      const candidate = facet[rank];
      if (!candidate) continue;
      foundAtRank = true;
      if (selectedKeys.has(candidate.key)) continue;
      selectedKeys.add(candidate.key);
      if (selected.length >= MAX_RAG_EVIDENCE_ITEMS) { truncated = true; stop = true; break; }
      const item = candidate.item;
      const content = String(item.content || "");
      const overhead = String(item.title || "").length + String(item.section || "").length;
      const remaining = MAX_INITIAL_EVIDENCE_CHARS - usedChars;
      if (remaining <= overhead) { truncated = true; stop = true; break; }
      const contentBudget = remaining - overhead;
      const clipped = content.length > contentBudget;
      const safeItem = clipped ? { ...item, content: content.slice(0, contentBudget), contentTruncated: true } : item;
      selected.push({ ...candidate, item: safeItem });
      usedChars += overhead + safeItem.content.length;
      if (clipped) { truncated = true; stop = true; break; }
    }
    if (!foundAtRank) break;
  }
  if (allUniqueKeys.size > selected.length) truncated = true;

  let evidence = selected.map(({ item }) => item);
  // Measure the exact prompt block after headers, source references, PII
  // redaction, and truncation notices have been rendered. The earlier
  // selection budget bounds source text; this final pass bounds what the
  // model actually receives.
  while (selected.length && formatApprovedKnowledgeEvidence({ type: "approved_knowledge", evidence, truncated }).length > MAX_INITIAL_EVIDENCE_CHARS) {
    const last = selected.at(-1);
    const rendered = formatApprovedKnowledgeEvidence({ type: "approved_knowledge", evidence, truncated });
    const overflow = rendered.length - MAX_INITIAL_EVIDENCE_CHARS;
    const content = String(last.item.content || "");
    if (content.length > overflow + 32) {
      last.item = { ...last.item, content: content.slice(0, content.length - overflow - 32), contentTruncated: true };
    } else {
      selected.pop();
      truncated = true;
    }
    evidence = selected.map(({ item }) => item);
  }
  const policyEvidence = selected.map(({ policy }) => ({
    sourceRef: policy.sourceRef || null,
    review_status: policy.review_status || null,
    valid_until: policy.valid_until || null,
    metadata: policy.metadata || { topic: null, facts: [] }
  }));
  const selectedRows = selected.map(({ item, policy, registerRows }) => {
    return {
      document_title: item.title,
      heading: item.section,
      content: item.content,
      chunk_id: item.sourceRef,
      review_status: policy.review_status,
      valid_until: policy.valid_until,
      policyMetadata: { ...policy.metadata, reviewStatus: policy.review_status, validUntil: policy.valid_until, factRegisterRows: registerRows }
    };
  });
  const selectedFactRows = new Map(selected.flatMap((candidate) => candidate.registerRows)
    .filter((row) => row?.id).map((row) => [row.id, row]));
  const status = evidence.length ? "found" : "no_evidence";
  const incomplete = retrievalFailures > 0;
  if (incomplete) {
    // A broad answer must not appear complete when any service facet failed.
    // Drop the successful partial evidence too; the model must take the
    // localized no-approved-information path instead of silently omitting an
    // area the customer reasonably asked us to cover.
    selected.length = 0;
    evidence = [];
    policyEvidence.length = 0;
    selectedRows.length = 0;
    selectedFactRows.clear();
  }
  const finalStatus = incomplete ? "error" : status;
  return {
    step: 0,
    tool: "searchApprovedKnowledge",
    args: { query: "balanced approved-knowledge search" },
    retrievalFacet: "balanced",
    result: {
      ok: !incomplete,
      status: finalStatus,
      ...(incomplete ? { reasonCode: "INCOMPLETE_BROAD_KNOWLEDGE_RETRIEVAL" } : {}),
      data: selectedRows,
      userSafeSummary: evidence.map((item) => String(item.section || item.title || "Approved information").slice(0, 120)),
      partialRetrievalFailures: retrievalFailures,
      modelObservation: { type: "approved_knowledge", status: finalStatus, evidence, truncated, policyEvidence,
        factRegisterRows: [...selectedFactRows.values()], partialRetrievalFailures: retrievalFailures }
    }
  };
}
function requiresApprovedKnowledge(intents) {
  return Array.isArray(intents) && intents.some((intent) => KNOWLEDGE_REQUIRED_INTENTS.has(intent));
}

function asksFormationPackagePrice(currentMessage, recentConversation = []) {
  const current = String(currentMessage || "").toLocaleLowerCase();
  const priceIntent = /\b(?:price|cost|fee|charge|how much|pricing)\b|كم\s*(?:السعر|تكلف|بيكلف)|قديش|سعر|تكلفة|(?:τιμή|κόστος|χρεώνετε|πόσο)|πόσα\s*(?:κοστίζει|χρεώνετε)/iu.test(current);
  if (!priceIntent) return false;
  const packageContext = /\b(?:formation|company setup|company formation|setup package|formation package|package)\b|تأسيس|باقة|الشركة|شركة|(?:σύσταση|εταιρεί|πακέτο)/iu;
  if (packageContext.test(current)) return true;
  // Only customer-authored prior turns can select the lookup. Assistant text
  // is untrusted continuity and is never used as evidence or a price source.
  return (Array.isArray(recentConversation) ? recentConversation : [])
    .filter((turn) => turn?.role === "user" && typeof turn.content === "string")
    .slice(-3).some((turn) => packageContext.test(turn.content));
}

async function initialApprovedOfferObservation(currentMessage, recentConversation, toolContext, tools) {
  if (!asksFormationPackagePrice(currentMessage, recentConversation)) return null;
  const tool = tools?.lookupActiveOffer;
  const args = { code: "formation-package" };
  let result;
  try {
    if (typeof tool?.run !== "function") throw new Error("Approved offer lookup is unavailable.");
    result = await tool.run(args, toolContext);
  } catch (error) {
    result = { ok: false, status: "error", reasonCode: "OFFER_LOOKUP_FAILED",
      message: String(error?.message || error).slice(0, 200),
      modelObservation: { type: "dynamic_data", source: "trusted_edge_dynamic_read", kind: "offers", status: "error", records: [] } };
  }
  return { step: 0, tool: "lookupActiveOffer", args, result, retrievalFacet: "formation-package-price" };
}

function contextualKnowledgeQuery(currentMessage, intents, recentConversation) {
  // A follow-up such as “and what does it cost?” is often classified as a
  // direct pricing intent. Keep the current-turn knowledge gate, but anchor
  // the search to the topic the customer was already discussing.
  const current = String(currentMessage || "").trim();
  const contextDependent = /\b(?:and (?:what|how) about|what about|how much (?:is|does) it|what does it cost|what does that include|tell me more|more details|is that included)\b|^(?:how much|how long)[?!.,\s]*$|\band\s+(?:the\s+)?(?:price|cost|fee|timeline)\b|(?:كم|قديش)\s*(?:السعر|بيكلف|تكلف)|شو\s*(?:بيشمل|السعر)|وهذا\s*(?:كم|قديش)|περιλαμβάνει|πόσο\s*(?:κοστίζει|είναι)|και\s*(?:η\s+)?(?:τιμή|κόστος)|^και\s+η\s+τιμή\s*[;;?!.\s]*$/iu.test(current);
  const hasDirectKnowledgeIntent = Array.isArray(intents) && intents.some((intent) => KNOWLEDGE_REQUIRED_INTENTS.has(intent));
  const greeklishContextDependent = /\b(?:kai\s+(?:i\s+)?(?:timi|kostos)|poso\s+(?:kostizei|einai)|ti\s+perilamvanei)\b/iu.test(current);
  if (hasDirectKnowledgeIntent && !contextDependent && !greeklishContextDependent) return null;
  const history = Array.isArray(recentConversation) ? recentConversation.slice(-6) : [];
  const priorUsers = history
    .filter((turn) => turn?.role === "user" && typeof turn.content === "string" && turn.content.trim())
    .slice(-2);
  if (!priorUsers.length) return null;
  if (contextDependent || greeklishContextDependent) {
    const latestPrior = priorUsers.at(-1);
    const acknowledgement = /^(?:hi|hello|hey|thanks|thank you|مرحبا|مرحباً|أهلا|اهلا|شكرا|شكرًا|γεια|ευχαριστώ)[؟?!.،\s]*$/iu.test(latestPrior.content.trim());
    const latestPriorIntent = acknowledgement ? priorUsers.at(-2) : latestPrior;
    if (!latestPriorIntent || (!detectIntent(latestPriorIntent.content).intents.some((intent) => KNOWLEDGE_REQUIRED_INTENTS.has(intent))
      && !KNOWN_KNOWLEDGE_TOPIC_TERMS.test(latestPriorIntent.content))) return null;
  }
  if (!contextDependent && !hasDirectKnowledgeIntent) {
    const priorIntents = detectIntent(priorUsers.at(-1).content).intents;
    if (!priorIntents.some((intent) => KNOWLEDGE_REQUIRED_INTENTS.has(intent))) return null;
  }
  const priorContext = history
    .filter((turn) => ["user", "assistant"].includes(turn?.role) && typeof turn.content === "string" && turn.content.trim())
    .slice(-4)
    .map((turn) => redactPersonalData(turn.content.trim()).slice(0, 220))
    .join("\n");
  const safeCurrent = redactPersonalData(current).slice(0, 300);
  return `${priorContext}\n${safeCurrent}`.slice(0, 900);
}

function appendBroadServiceFollowup(result, { intents, locale, currentMessage, recentConversation } = {}) {
  if (result?.outcome !== "responded" || typeof result.response !== "string") return result;
  if (!Array.isArray(intents) || !intents.includes(INTENTS.SERVICES)
      || intents.some((intent) => SPECIALIZED_SERVICE_INTENTS.has(intent))) return result;
  if (/[?؟]/u.test(result.response)) return result;
  const language = String(locale || "").toLowerCase();
  const key = language.startsWith("ar") ? "ar" : language.startsWith("el") || language.startsWith("greek") ? "el" : "en";
  const priorAssistantText = (Array.isArray(recentConversation) ? recentConversation : [])
    .filter((turn) => turn?.role === "assistant" && typeof turn.content === "string")
    .slice(-8)
    .map((turn) => turn.content.toLocaleLowerCase().replace(/[؟?!.،,؛;\s]+/gu, " ").trim());
  const followupKey = BROAD_SERVICE_FOLLOWUPS[key].toLocaleLowerCase().replace(/[؟?!.،,؛;\s]+/gu, " ").trim();
  // Broad service answers get a useful next step, but repeating the same
  // generic prompt across turns feels like a stuck bot. Recent assistant
  // messages are continuity only; this check only suppresses our fixed
  // follow-up and never treats their content as business evidence.
  if (priorAssistantText.some((text) => text.includes(followupKey))) return result;
  const response = `${result.response.trim()} ${BROAD_SERVICE_FOLLOWUPS[key]}`;
  const checked = validateResponse(response, { ...MODEL_DRAFT_THRESHOLDS, customerMessage: currentMessage });
  return checked.valid ? { ...result, response: checked.text } : result;
}

async function initialKnowledgeObservation(currentMessage, intents, recentConversation, toolContext, tools, locale) {
  const directKnowledgeIntent = Array.isArray(intents) && intents.some((intent) => KNOWLEDGE_REQUIRED_INTENTS.has(intent));
  const contextualQuery = contextualKnowledgeQuery(currentMessage, intents, recentConversation);
  const offerObservationPromise = initialApprovedOfferObservation(currentMessage, recentConversation, toolContext, tools);
  if (!directKnowledgeIntent && !contextualQuery) {
    const offerObservation = await offerObservationPromise;
    return offerObservation ? [offerObservation] : [];
  }
  const tool = tools?.searchApprovedKnowledge;
  const message = String(currentMessage || "").trim().slice(0, 1000);
  const broad = Array.isArray(intents) && intents.some((intent) => BROAD_COMPANY_INTENTS.has(intent));
  const baseQuery = contextualQuery || message;
  const localeValue = String(locale || "").toLowerCase();
  const languageKey = localeValue.startsWith("ar") || localeValue === "arabic" ? "ar"
    : localeValue.startsWith("el") || localeValue === "greek" ? "el" : "en";
  const retrieval = BROAD_COMPANY_RETRIEVAL[languageKey];
  const queries = broad
    ? retrieval.facets.map((facet, index) =>
      // Keep the original customer wording and portfolio overview in one
      // lead query. Repeating a potentially long, multi-topic question in
      // every facet dilutes lexical/vector matching and can crowd relevant
      // hits; the remaining searches should target one localized facet each.
      index === 0 ? `${baseQuery}\n${retrieval.overview}\n${facet}` : facet)
    : [baseQuery];
  const observations = await Promise.all(queries.map(async (rawQuery, index) => {
    const args = { query: rawQuery.slice(0, 1800) };
    let result;
    try {
      if (typeof tool?.run !== "function") throw new Error("Approved knowledge search is unavailable.");
      result = await tool.run(args, toolContext);
    } catch (error) {
      result = {
        ok: false,
        status: "error",
        reasonCode: "RETRIEVAL_FAILED",
        message: String(error?.message || error).slice(0, 200),
        modelObservation: { type: "approved_knowledge", status: "error", evidence: [], truncated: false }
      };
    }
    return { step: 0, tool: "searchApprovedKnowledge", args, result, retrievalFacet: broad ? index + 1 : null };
  }));
  const offerObservation = await offerObservationPromise;
  return [...(broad ? [mergeBroadFacetEvidence(observations)] : observations), ...(offerObservation ? [offerObservation] : [])];
}

// Everything a tool might need, bound once per turn. Deliberately narrow:
// only what the Ticket 001 tools actually read (store, user, userId, intents,
// language, embedding settings) — never raw transport/session internals.
function buildToolContext({
  store,
  user,
  userId,
  intents = [],
  language,
  embedText = defaultEmbedText,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  matchCount = MAX_RAG_EVIDENCE_ITEMS,
  // REFAL-AGENT-009 booking-tool dependencies.
  // `inboundMessageId` is the real WhatsApp provider message id — the same id
  // the dedup layer in bot.js already claims against — so a duplicate-delivered
  // message naturally produces the same derived idempotencyKey and cannot
  // become a second appointment. Optional: without it the booking write tool
  // fails closed rather than inventing a fresh random key per call.
  // `policy` is the already-loaded booking policy; when omitted the tools read
  // it once via store.getBookingPolicy().
  inboundMessageId = null,
  // M4 receipt foreign key: a persisted conversation-turn UUID supplied by
  // the trusted caller. Provider message ids remain separate for booking
  // idempotency and are never substituted for this database identity.
  sourceTurnId = null,
  consentState = "unknown",
  allowedCapabilities = [],
  policy = null,
  currentMessage = ""
} = {}) {
  return {
    store, user, userId, intents, language, embedText, embeddingModel, matchCount,
    inboundMessageId, sourceTurnId, consentState,
    // Bound by the trusted caller, never by the model. CRM extraction uses
    // this exact inbound turn to verify that a proposed value was stated.
    currentMessage: String(currentMessage || "").slice(0, 4000),
    allowedCapabilities: Object.freeze([...new Set((Array.isArray(allowedCapabilities) ? allowedCapabilities : []).filter((value) => typeof value === "string"))]),
    policy
  };
}

// The one real entry point for a full Agent turn. `store` and `user` must
// already be loaded by the caller (never fetched again here — see the
// double-load race documented in docs/refal-agent-refactor-progress.md).
async function runAgentTurnForContact({
  currentMessage,
  locale,
  contact,
  recentConversation,
  conversationState,
  knownCustomerFacts,
  currentOpenQuestion,
  consentState,
  allowedCapabilities,
  leadTier,
  buyingSignals,
  store,
  user,
  userId,
  intents,
  language,
  embedText,
  embeddingModel,
  matchCount,
  inboundMessageId,
  sourceTurnId,
  policy
} = {}, {
  decideNextStep = defaultDecideNextStep,
  onModelCall,
  onModelUsage,
  tools = TOOL_REGISTRY,
  maxSteps = DEFAULT_MAX_STEPS
} = {}) {
  const context = buildAgentContext({
    currentMessage,
    locale,
    contact,
    recentConversation,
    conversationState,
    knownCustomerFacts,
    currentOpenQuestion,
    consentState,
    allowedCapabilities,
    leadTier,
    buyingSignals
  });
  const toolContext = buildToolContext({
    store, user, userId, intents, language, embedText, embeddingModel, matchCount,
    inboundMessageId, sourceTurnId, consentState, allowedCapabilities, policy, currentMessage
  });
  const initialObservations = await initialKnowledgeObservation(currentMessage, intents, recentConversation, toolContext, tools, locale);
  const incompleteBroadRetrieval = initialObservations.length === 1
    && initialObservations[0]?.retrievalFacet === "balanced"
    && initialObservations[0]?.result?.reasonCode === "INCOMPLETE_BROAD_KNOWLEDGE_RETRIEVAL";
  if (incompleteBroadRetrieval) {
    const language = String(locale || "").toLowerCase();
    const replyLanguage = language.startsWith("ar") || language === "arabic" ? "arabic"
      : language.startsWith("el") || language === "greek" ? "greek" : "english";
    return {
      outcome: "responded",
      response: noApprovedEvidenceReply(replyLanguage),
      steps: initialObservations,
      toolsUsed: ["searchApprovedKnowledge"],
      stepCount: 0,
      reasonCode: "INCOMPLETE_BROAD_KNOWLEDGE_RETRIEVAL"
    };
  }
  const measuredDecideNextStep = (onModelCall || onModelUsage) && decideNextStep === defaultDecideNextStep
    ? (args) => decideNextStep(args, { onModelCall, onModelUsage })
    : decideNextStep;
  const result = await runAgentTurn(context, { decideNextStep: measuredDecideNextStep, tools, toolContext, maxSteps, initialObservations });
  return appendBroadServiceFollowup(result, { intents, locale, currentMessage, recentConversation });
}

module.exports = { runAgentTurnForContact, buildToolContext, requiresApprovedKnowledge, appendBroadServiceFollowup };
