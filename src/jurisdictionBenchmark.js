"use strict";

// M5 P5.3: deterministic guard for jurisdiction comparisons (MB-J0..J4).
// Comparative facts remain evidence-gated; this module supplies no tax, legal,
// immigration, banking, or investment advice of its own.
const { isApprovedEvidence, evaluateAnswerClaims, splitClaims } = require("./claimPolicy");
const { classifyEvidence } = require("./factRegister");

const TOPICS = Object.freeze({
  "jurisdiction-dubai": { fact: "MB-J1", id: 26 },
  "jurisdiction-estonia": { fact: "MB-J2", id: 27 },
  "jurisdiction-malta-bulgaria": { fact: "MB-J3", id: 28 },
  "jurisdiction-usa": { fact: "MB-J4", id: 29 },
});

const DISCOVERY_QUESTION = Object.freeze({
  en: "Where are your clients, your bank, and your family?",
  ar: "أين يوجد عملاؤك وبنكك وعائلتك؟",
  el: "Πού βρίσκονται οι πελάτες σας, η τράπεζά σας και η οικογένειά σας;",
});

// These are evaluative attacks, not factual trade-offs. The matcher covers
// direct and common euphemistic language in the three supported languages.
const DISPARAGEMENT = /\b(?:backward|corrupt|terrible|awful|inferior|bad(?:\s+choice)?|useless|unsafe|unreliable|unstable|chaotic|hostile|broken|a\s+mess|nightmare|tax\s+haven\s+scam|suffers?\s+(?:from\s+)?(?:serious\s+)?(?:banking|structural)\s+constraints?|serious\s+disadvantages?|failed\s+jurisdiction|not\s+a\s+serious\s+(?:option|choice)|worst|better\s+than\s+(?:any|all|every))\b|\b(?:cyprus|we|our\s+(?:country|system))\b[^.!?]{0,45}\b(?:always|invariably)\s+(?:the\s+)?(?:best|better|superior)\b|(?:متخلف|فاسد|سيئ|سيئة|رديء|رديئة|عديم\s+الفائدة|غير\s+آمن|فوضوي|كارثي|أسوأ|بلد\s+فاشل|خيار\s+غير\s+جاد|قبرص[^.!؟]{0,45}(?:دائماً|دائمًا)\s+الأفضل|نحن[^.!؟]{0,35}(?:دائماً|دائمًا)\s+الأفضل)|(?:οπισθοδρομικ\p{L}*|διεφθαρμέν\p{L}*|απαίσ\p{L}*|άχρηστ\p{L}*|κατώτερ\p{L}*|αναξιόπιστ\p{L}*|χαοτικ\p{L}*|χειρότερ\p{L}*|αποτυχημέν\p{L}*|Κύπρ\p{L}*[^.!?]{0,45}πάντα\s+(?:η\s+)?καλύτερ\p{L}*)/iu;

function approvedTopicEvidence(topicSlug, evidence) {
  const topic = TOPICS[topicSlug];
  if (!topic || !Array.isArray(evidence)) return false;
  const foundFacts = new Set();
  for (const item of evidence) {
    if (!isApprovedEvidence(item)) return false;
    const ref = String(item.sourceRef ?? item.source_ref ?? item.canonical_url ?? "");
    const content = String(item.content ?? item.text ?? "");
    // Require approved provenance for both posture and the relevant topic.
    // Evidence must carry the extracted fact identifiers or the canonical
    // topic slug; arbitrary approved material cannot unlock a comparison.
    const metadata = item.metadata || item.p_metadata || {};
    const hasTopic = ref.includes(topicSlug) || item.topicSlug === topicSlug || item.topic_slug === topicSlug || metadata.topic === topicSlug;
    const ids = [item.factId, item.fact_id, ...(Array.isArray(item.factIds) ? item.factIds : []), ...(Array.isArray(item.fact_ids) ? item.fact_ids : []), ...(Array.isArray(metadata.facts) ? metadata.facts : [])]
      .map(String);
    if (hasTopic && content.trim().length > 0) ids.forEach((id) => foundFacts.add(id));
  }
  return foundFacts.has("MB-J0") && foundFacts.has(topic.fact);
}

function hasApprovedDiscoveryQuestion(text, language = "en") {
  const normalized = String(text || "").trim();
  const question = DISCOVERY_QUESTION[language];
  return Boolean(question && normalized.endsWith(question));
}

function normalizeSourceText(value) {
  return String(value || "").toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}

function everyClaimVerbatimInEvidence(text, evidence) {
  const sources = evidence.map((item) => normalizeSourceText(item.content ?? item.text ?? ""));
  const claims = splitClaims(text).map(normalizeSourceText).filter(Boolean);
  return claims.length > 0 && claims.every((claim) => sources.some((source) => source.includes(claim)));
}

function validateJurisdictionComparison({ topicSlug, text, evidence, factRegister, language = "en", now } = {}) {
  const draft = String(text || "").trim();
  const issues = [];
  if (!TOPICS[topicSlug]) issues.push("unsupported_topic");
  if (!draft) issues.push("empty_response");
  if (draft && DISPARAGEMENT.test(draft)) issues.push("disparages_jurisdiction");
  if (draft && !hasApprovedDiscoveryQuestion(draft, language)) issues.push("missing_approved_discovery_question");
  if (TOPICS[topicSlug] && !approvedTopicEvidence(topicSlug, evidence)) issues.push("missing_approved_topic_evidence");
  if (TOPICS[topicSlug]) {
    const topicFact = TOPICS[topicSlug].fact;
    const requiredFacts = ["MB-J0", topicFact];
    if (!(factRegister instanceof Map)) {
      issues.push("missing_fact_register");
    } else {
      const classified = classifyEvidence(
        [{ metadata: { facts: requiredFacts } }],
        { register: factRegister, now, lang: language },
      );
      if (!requiredFacts.every((id) => classified.statable.includes(id))) issues.push("facts_not_statable");
    }
  }
  if (draft && TOPICS[topicSlug]) {
    const approved = Array.isArray(evidence) ? evidence.filter(isApprovedEvidence) : [];
    const question = DISCOVERY_QUESTION[language];
    const factualBody = question ? draft.slice(0, -question.length).trim() : draft;
    if (factualBody && (!evaluateAnswerClaims(factualBody, { evidence: approved }).allowed
      || !everyClaimVerbatimInEvidence(factualBody, approved))) {
      issues.push("unsupported_jurisdictional_claim");
    }
  }
  return { ok: issues.length === 0, issues };
}

module.exports = {
  TOPICS,
  DISCOVERY_QUESTION,
  approvedTopicEvidence,
  hasApprovedDiscoveryQuestion,
  validateJurisdictionComparison,
};
