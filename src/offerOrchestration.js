"use strict";

// M5 P5.4: select at most one safe next-step candidate. This module only
// chooses a response path; it never invokes booking, handover, or other tools.
const { resolveConflict, SOURCE_LEVELS, assertModelKnowledgeIsGeneral } = require("./policyPrecedence");

const TYPE_ORDER = Object.freeze(["booking", "specialist", "objection"]);
const VALID_TYPES = new Set([...TYPE_ORDER, "jurisdiction", "hook", "nothing"]);

function policyAllows(candidate) {
  // The orchestration rule is owner policy. It is the default governing source;
  // candidates may add actual conflicting sources for precedence evaluation.
  const source = candidate.source || { level: SOURCE_LEVELS.OWNER_POLICY, id: "m5_orchestration_policy" };
  try {
    const conflicts = Array.isArray(candidate.conflicts) ? candidate.conflicts : [];
    const decision = resolveConflict([source, ...conflicts]);
    if (!decision.winner || decision.winner !== source) return false;
  } catch {
    return false;
  }
  if (source.level === SOURCE_LEVELS.MODEL_KNOWLEDGE) {
    const check = assertModelKnowledgeIsGeneral(candidate.text || candidate.response || "", source.level);
    if (!check.ok) return false;
  }
  return true;
}

function blockedByTurnState(context) {
  return context.optOut === true
    || context.declined === true
    || context.informational === true
    || context.complaint === true
    || context.sensitive === true
    || context.noProactiveContact === true
    || context.pendingBooking === true
    || context.handoverActive === true
    || context.complianceLock === true
    || context.humourLevel === 0;
}

function hasAtMostOneQuestion(candidate) {
  const response = String(candidate.response || candidate.text || "").trim();
  if (!response) return true;
  const marks = (response.match(/[?؟]/gu) || []).length;
  // Greek uses semicolon as its question mark. Count it independent of the
  // candidate's claimed locale so a bad locale label cannot bypass the gate.
  const greekMarks = (response.match(/;/gu) || []).length;
  return marks + greekMarks <= 1;
}

function candidateEligible(candidate, context, offered) {
  if (!candidate || !VALID_TYPES.has(candidate.type) || candidate.type === "nothing") return false;
  if (candidate.eligible === false || candidate.validated === false || !policyAllows(candidate) || !hasAtMostOneQuestion(candidate)) return false;
  if (candidate.id && offered.has(candidate.id)) return false;
  if (candidate.type === "hook") {
    if (!candidate.id || offered.has(candidate.id)) return false;
    if (candidate.validated !== true) return false;
    if (context.answerComplete !== true || context.humourLevel == null || Number(context.humourLevel) <= 0) return false;
  }
  if (candidate.type === "booking" && (candidate.validated !== true || (candidate.mode === "offer"
    ? candidate.consentRequired !== true || context.bookingOfferAllowed !== true
    : context.explicitBookingRequest !== true || context.explicitBookingConsent !== true))) return false;
  if (candidate.type === "specialist" && (candidate.validated !== true || (candidate.mode === "offer"
    ? candidate.consentRequired !== true
    : context.handoverConsent !== true))) return false;
  if (candidate.type === "objection" && candidate.validated !== true) return false;
  if (candidate.type === "jurisdiction" && candidate.validated !== true) return false;
  return true;
}

/**
 * Return { type, candidate, reason }. The candidate is data for the caller to
 * render; it is never executed here. Required context booleans fail closed.
 */
function selectOfferForTurn({ candidates = [], context = {}, previouslyOffered = [] } = {}) {
  if (blockedByTurnState(context) || context.answerComplete !== true) return { type: "nothing", candidate: null, reason: "turn_suppressed" };
  const offered = new Set(Array.isArray(previouslyOffered) ? previouslyOffered : []);
  const list = Array.isArray(candidates) ? candidates : [];
  for (const type of TYPE_ORDER) {
    const candidate = list.find((item) => item?.type === type && candidateEligible(item, context, offered));
    if (candidate) return { type, candidate, reason: "eligible_highest_priority" };
  }
  const jurisdiction = list.find((item) => item?.type === "jurisdiction" && candidateEligible(item, context, offered));
  if (jurisdiction) return { type: "jurisdiction", candidate: jurisdiction, reason: "eligible_highest_priority" };
  const hook = list.find((item) => item?.type === "hook" && candidateEligible(item, context, offered));
  if (hook) return { type: "hook", candidate: hook, reason: "eligible_highest_priority" };
  return { type: "nothing", candidate: null, reason: "no_eligible_candidate" };
}

module.exports = { selectOfferForTurn };
