"use strict";

// Conversation quality counters (sizes, counts and states only, never text).
// Emitted on agent_turn_completed when any conversation flag is on, and reused
// by scripts/evaluateConversationQuality.js to compute rates offline.

const { findUnsupportedActionClaims } = require("./truthfulActionGuard");
const { isQuestionText, splitSentences, sameName } = require("./sessionMemory");

function createQualityCounters() {
  return { followupsStripped: 0, vagueFollowupsStripped: 0, repeatedQuestionsStripped: 0, knownFieldQuestionsStripped: 0,
    unsupportedClaimsBlocked: 0, unsupportedClaimsRemoved: 0, nameOpenersDeduped: 0, clarificationLimitHits: 0 };
}

function countFollowupRemovals(counters, removed = []) {
  if (!counters) return;
  for (const code of removed) {
    counters.followupsStripped += 1;
    if (code === "vague_question") counters.vagueFollowupsStripped += 1;
    else if (code === "repeated_question") counters.repeatedQuestionsStripped += 1;
    else counters.knownFieldQuestionsStripped += 1;
  }
}

/** Per-turn quality fields for agent_turn_completed. Counts only. */
function turnQualityFields({ counters = createQualityCounters(), sessionState = null, responseText = "", agentResult = {} } = {}) {
  const reply = String(responseText || "");
  const questions = splitSentences(reply).filter(isQuestionText);
  const conv = sessionState?.conversation || {};
  const asked = (conv.askedQuestions || []).filter((entry) => entry.answered).map((entry) => entry.text);
  const normalize = (value) => String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
  const repeated = questions.some((question) => asked.some((text) => normalize(text) === normalize(question)));
  const wrongNames = (sessionState?.user?.nameCorrections || []).filter((entry) => entry.reason === "rejected").map((entry) => entry.value);
  const correctedValueUsed = wrongNames.some((name) => new RegExp(`(?:^|[^\\p{L}])${String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\p{L}])`, "iu").test(reply)
    && !sameName(name, sessionState?.user?.name?.value));
  const evidenceCount = (Array.isArray(agentResult.steps) ? agentResult.steps : [])
    .reduce((sum, step) => sum + (step?.result?.modelObservation?.evidence?.length || 0), 0);
  const unsupported = reply && sessionState ? findUnsupportedActionClaims(reply, { actionState: sessionState.actions || {} }).findings.length : 0;
  return {
    cqSessionItems: (conv.requirements?.length || 0) + (conv.tentative?.length || 0) + (sessionState?.user?.name ? 1 : 0) + (sessionState?.user?.country ? 1 : 0),
    cqConfirmedItems: (conv.requirements?.length || 0) + (sessionState?.user?.name?.status === "confirmed" ? 1 : 0),
    cqTentativeItems: conv.tentative?.length || 0,
    cqCorrectedItems: conv.corrections?.length || 0,
    cqOpenQuestions: conv.openQuestions?.length || 0,
    cqClarificationStreak: conv.clarificationStreak || 0,
    cqHandoffState: sessionState?.actions?.handoff?.status || null,
    cqBookingState: sessionState?.actions?.booking?.status || null,
    cqReplyQuestions: questions.length,
    cqReplyChars: reply.length,
    cqRepeatedQuestion: repeated ? 1 : 0,
    cqCorrectedValueUsed: correctedValueUsed ? 1 : 0,
    cqUnsupportedClaimsInReply: unsupported,
    cqEvidenceItems: evidenceCount,
    cqFollowupsStripped: counters.followupsStripped,
    cqVagueFollowupsStripped: counters.vagueFollowupsStripped,
    cqRepeatedQuestionsStripped: counters.repeatedQuestionsStripped,
    cqKnownFieldQuestionsStripped: counters.knownFieldQuestionsStripped,
    cqUnsupportedClaimsBlocked: counters.unsupportedClaimsBlocked,
    cqUnsupportedClaimsRemoved: counters.unsupportedClaimsRemoved,
    cqNameOpenersDeduped: counters.nameOpenersDeduped,
    cqClarificationLimitHits: counters.clarificationLimitHits
  };
}

module.exports = { createQualityCounters, countFollowupRemovals, turnQualityFields };
