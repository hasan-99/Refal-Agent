"use strict";

// Runtime composition for M5. These helpers only amend already-completed,
// validated answers; they never authorize a booking or contact action.
const { selectSalesHook } = require("./salesHooks");
const { objectionMatrix, identifyObjection } = require("./objectionMatrix");
const { selectOfferForTurn } = require("./offerOrchestration");
const { validateJurisdictionComparison, TOPICS, DISCOVERY_QUESTION } = require("./jurisdictionBenchmark");
const { seedRegister, applyOverrides } = require("./factRegister");
const { resolveHumourLevel } = require("./humourEngine");
const { validateResponse, LEGACY_RESPONSE_THRESHOLDS, MODEL_DRAFT_THRESHOLDS } = require("./responsePolicy");
const { validateFactualGrounding } = require("./groundingPolicy");
const { detectMessageLanguage } = require("./language");
const { TOOL_REGISTRY } = require("./agentTools");
const { collectApprovedKnowledgeEvidence, collectFactRegisterRows } = require("./groundingPolicy");
const { INTENTS } = require("./intent");

const INFORMATIONAL_INTENTS = new Set([
  INTENTS.GREETING, INTENTS.SMALL_TALK, INTENTS.AGENT_IDENTITY,
  INTENTS.COMPANY_INFO, INTENTS.BUSINESS_AREAS, INTENTS.SERVICES, INTENTS.CONTACT,
  INTENTS.GENERAL_INFORMATION, INTENTS.PRICING
]);

function hasInformationalIntent(intents) {
  return (Array.isArray(intents) ? intents : []).some((intent) => INFORMATIONAL_INTENTS.has(intent));
}

function languageKey(language, text = "") {
  const value = String(language || detectMessageLanguage(text)).toLowerCase();
  return value.startsWith("ar") ? "ar" : value.startsWith("el") || value.includes("greek") ? "el" : "en";
}

function normalizeMatchText(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function evidenceForPolicy(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    content: String(row?.content || ""),
    title: row?.document_title || row?.source_name || "",
    section: row?.heading || "",
    sourceRef: row?.chunk_id || row?.document_id || row?.source_id || null,
    review_status: row?.policyMetadata?.reviewStatus || row?.review_status || null,
    valid_until: row?.policyMetadata?.validUntil || row?.valid_until || null,
    topic: row?.policyMetadata?.topic || null,
    metadata: {
      topic: row?.policyMetadata?.topic || null,
      facts: Array.isArray(row?.policyMetadata?.facts) ? row.policyMetadata.facts : []
    }
  }));
}

function observationPolicyRows(observations = []) {
  const factRegisterRows = collectFactRegisterRows(observations);
  return collectApprovedKnowledgeEvidence(observations).map((item) => ({
    content: item.content,
    sourceRef: item.sourceRef,
    review_status: item.review_status,
    valid_until: item.valid_until,
    policyMetadata: {
      topic: item.metadata?.topic || null,
      facts: item.metadata?.facts || [],
      factRegisterRows
    }
  }));
}

function factRegisterForRows(rows = []) {
  const register = seedRegister();
  const overrides = [];
  const declaredFacts = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const id of Array.isArray(row?.policyMetadata?.facts) ? row.policyMetadata.facts : []) declaredFacts.add(id);
    for (const fact of Array.isArray(row?.policyMetadata?.factRegisterRows) ? row.policyMetadata.factRegisterRows : []) {
      if (!fact?.id) continue;
      overrides.push({
        id: fact.id,
        status: fact.status,
        reviewer: fact.reviewer,
        verifiedAt: fact.verifiedAt,
        effectiveFrom: fact.effectiveFrom,
        expiryOrReviewAt: fact.expiryOrReviewAt,
        approvedLanguages: fact.approvedLanguages
      });
    }
  }
  const loadedIds = new Set(overrides.map((row) => row.id));
  // A search/RPC or register lookup failure must not silently fall back to
  // the local seed when the retrieved chunk declared those facts.
  if (!declaredFacts.size || [...declaredFacts].some((id) => !loadedIds.has(id))) return new Map();
  try { applyOverrides(register, overrides); } catch { return new Map(); }
  return register;
}

function priorHookIds(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((turn) => turn?.metadata?.salesOffer?.id)
    .filter((id) => typeof id === "string");
}

function localizedComparisonFallback(language) {
  return {
    en: `I can compare the approved information once the relevant facts are confirmed. ${DISCOVERY_QUESTION.en}`,
    ar: `أستطيع مقارنة المعلومات المعتمدة بعد تأكيد الحقائق ذات الصلة. ${DISCOVERY_QUESTION.ar}`,
    el: `Μπορώ να συγκρίνω τις εγκεκριμένες πληροφορίες μόλις επιβεβαιωθούν τα σχετικά στοιχεία. ${DISCOVERY_QUESTION.el}`
  }[language];
}

function requestedJurisdiction(message, rows) {
  const text = normalizeMatchText(message);
  const candidates = Object.keys(TOPICS).filter((slug) => {
    const key = slug.replace("jurisdiction-", "");
    const aliases = key === "malta-bulgaria" ? ["malta", "bulgaria", "مالطا", "بلغاريا", "μαλτα", "βουλγαρια"]
      : key === "usa" ? ["usa", "united states", "امريكا", "الولايات المتحدة", "ηπα", "αμερικη", "ηνωμενες πολιτειες"]
        : key === "estonia" ? ["estonia", "استونيا", "εσθονια"]
          : ["dubai", "دبي", "ντουμπαι"];
    return aliases.some((alias) => text.includes(alias));
  });
  if (candidates.length === 1) return candidates[0];
  const topics = [...new Set((Array.isArray(rows) ? rows : []).map((row) => row?.policyMetadata?.topic).filter((topic) => TOPICS[topic]))];
  return topics.length === 1 ? topics[0] : null;
}

function isComparisonRequest(message) {
  return /\b(?:compare|comparison|versus|vs\.?|alternative|different from|better than)\b|مقارن|مقابل|الفرق|συγκρ|διαφορ/iu.test(normalizeMatchText(message));
}

function guardJurisdictionAnswer({ message, response, rows = [], language, now = new Date() } = {}) {
  const lang = languageKey(language, message);
  if (!isComparisonRequest(message)) return { response, guarded: false, valid: true };
  const evidence = evidenceForPolicy(rows);
  const topicSlug = requestedJurisdiction(message, rows);
  if (!topicSlug) return { response: localizedComparisonFallback(lang), guarded: true, valid: false, issues: ["unsupported_topic"] };
  const validation = validateJurisdictionComparison({
    topicSlug, text: response, evidence, factRegister: factRegisterForRows(rows), language: lang, now
  });
  if (!validation.ok) return { response: localizedComparisonFallback(lang), guarded: true, valid: false, issues: validation.issues, topicSlug };
  const selection = selectOfferForTurn({
    candidates: [{ type: "jurisdiction", id: topicSlug, validated: true, response, language: lang }],
    context: { answerComplete: true, humourLevel: 1 }
  });
  return selection.type === "jurisdiction"
    ? { response: selection.candidate.response, guarded: true, valid: true, topicSlug }
    : { response: localizedComparisonFallback(lang), guarded: true, valid: false, issues: ["orchestration_rejected"], topicSlug };
}

function appendGroundedHook({ message, response, language, humourLevel, history = [], user = {}, rows = [], suppressed = {}, specialistEligible = false, answerComplete = false } = {}) {
  const lang = languageKey(language, message);
  const evidence = evidenceForPolicy(rows);
  const humour = humourLevel == null ? resolveHumourLevel({ message, history, language: lang }).level : humourLevel;
  const specialistPreviouslyOffered = history.some((turn) => turn?.metadata?.specialistOffer?.consentRequired === true
    && Number.isFinite(Date.parse(turn.metadata.specialistOffer.offeredAt || turn.at || ""))
    && Date.now() - Date.parse(turn.metadata.specialistOffer.offeredAt || turn.at || "") <= 24 * 60 * 60 * 1000);
  const preferences = user?.profile?.conversationPreferences || {};
  const suppressedState = {
    noProactiveContact: preferences.noProactiveBookingOrContact === true,
    optOut: suppressed.optOut === true, declined: suppressed.declined === true,
    informational: suppressed.informational === true, complaint: suppressed.complaint === true,
    sensitive: suppressed.sensitive === true, pendingBooking: suppressed.pendingBooking === true,
    handoverActive: suppressed.handoverActive === true, complianceLock: suppressed.complianceLock === true
  };
  if (specialistEligible && answerComplete && !specialistPreviouslyOffered) {
    const offer = {
      en: "With your permission, I can ask a Refalco Group specialist to follow up. Would you like that?",
      ar: "إذا بتحب، فيني أطلب من مختص من Refalco Group يتابع معك. هل يناسبك ذلك؟",
      el: "Με την άδειά σας, μπορώ να ζητήσω από ειδικό της Refalco Group να επικοινωνήσει μαζί σας. Θα το θέλατε;"
    }[lang];
    const composed = `${String(response || "").trim()} ${offer}`.trim();
    const selection = selectOfferForTurn({
      candidates: [{ type: "specialist", id: "specialist-follow-up", mode: "offer", consentRequired: true, validated: true, response: composed, language: lang }],
      context: { ...suppressedState, answerComplete: true, humourLevel: humour }
    });
    if (selection.type === "specialist" && validateResponse(composed, LEGACY_RESPONSE_THRESHOLDS).valid) {
      return { response: composed, salesOffer: null, specialistOffer: { offered: true, consentRequired: true, offeredAt: new Date().toISOString() } };
    }
  }
  const hook = selectSalesHook({
    message, language: lang, humourLevel: humour, answer: response, questionAnswered: Boolean(String(response || "").trim()),
    previouslyOfferedHooks: priorHookIds(history), evidence,
    informational: suppressed.informational === true,
    complaint: suppressed.complaint === true,
    sensitive: suppressed.sensitive === true,
    declined: suppressed.declined === true
  });
  if (!hook) return { response, salesOffer: null };
  const composed = `${String(response).trim()} ${hook.phrase}`;
  const selection = selectOfferForTurn({
    candidates: [{ type: "hook", id: hook.id, validated: true, response: composed, language: lang }],
    context: {
      answerComplete: true, humourLevel: humour,
      noProactiveContact: preferences.noProactiveBookingOrContact === true,
      optOut: suppressed.optOut === true, declined: suppressed.declined === true,
      informational: suppressed.informational === true, complaint: suppressed.complaint === true,
      sensitive: suppressed.sensitive === true, pendingBooking: suppressed.pendingBooking === true,
      handoverActive: suppressed.handoverActive === true, complianceLock: suppressed.complianceLock === true
    },
    previouslyOffered: priorHookIds(history)
  });
  if (selection.type !== "hook") return { response, salesOffer: null };
  const policy = validateResponse(composed, LEGACY_RESPONSE_THRESHOLDS);
  const grounding = validateFactualGrounding(composed, { evidenceItems: evidence });
  if (!policy.valid || !grounding.valid) return { response, salesOffer: null };
  return { response: composed, salesOffer: { type: "hook", id: hook.id } };
}

async function buildObjectionAnswer({ text, language, store, humourLevel = 2, now = new Date() } = {}) {
  const objection = identifyObjection(text);
  if (!objection) return null;
  let offers = [];
  let knowledgeRows = [];
  try {
    if (["O1", "O2"].includes(objection)) {
      const result = await TOOL_REGISTRY.lookupActiveOffer.run({ code: "formation-package" }, { store, now });
      offers = result?.modelObservation?.records || [];
    }
    if (objection === "O5" && typeof store?.searchKnowledge === "function") {
      knowledgeRows = await store.searchKnowledge(text, null, null, 6) || [];
    }
  } catch { /* Evidence failure produces a safe, non-evidentiary matrix reply. */ }
  const lang = languageKey(language, text);
  const matrix = objectionMatrix({
    text, language: lang, offers, now, humourLevel,
    credibilityEvidence: evidenceForPolicy(knowledgeRows),
    factRegister: factRegisterForRows(knowledgeRows)
  });
  const selection = selectOfferForTurn({
    candidates: [{ type: "objection", id: matrix.objection, validated: matrix.safe, response: matrix.response, language: lang }],
    context: { answerComplete: true, humourLevel }
  });
  return selection.type === "objection" ? { ...matrix, response: selection.candidate.response } : null;
}

module.exports = {
  languageKey, hasInformationalIntent, evidenceForPolicy, factRegisterForRows, priorHookIds,
  observationPolicyRows, guardJurisdictionAnswer, appendGroundedHook, buildObjectionAnswer,
  isComparisonRequest, requestedJurisdiction
};
