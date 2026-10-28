#!/usr/bin/env node
"use strict";

// Offline conversation-quality evaluator. Reads simulated (or exported,
// already-redacted) conversations and computes the quality rates used to judge
// the conversational-behaviour flags. Deterministic; no model, no network,
// no database. Usage:
//   node scripts/evaluateConversationQuality.js [conversations.json]
// Input: [{ id, turns: [{ customer, reply, llmCalls, latencyMs, handoffState,
//   bookingState, leadSaved, evidence: [approved text], correctedNames: [],
//   expect: { mustMention: [], answerable: true } }] }]
// Without a file it evaluates a small built-in sample.

const fs = require("node:fs");
const { findUnsupportedActionClaims } = require("../src/truthfulActionGuard");
const { splitSentences, isQuestionText, containsWord } = require("../src/sessionMemory");

const HANDOFF_CODES = new Set(["handoff_notified", "handoff_sent", "handoff_accepted", "human_joined", "contact_promise"]);
const BOOKING_CODES = new Set(["booking_submitted", "booking_confirmed"]);

const normalize = (text) => String(text || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
function similar(a, b) {
  const left = new Set(normalize(a).split(" ").filter((t) => t.length > 1));
  const right = new Set(normalize(b).split(" ").filter((t) => t.length > 1));
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.8;
}
const numbersIn = (text) => (String(text || "").match(/\d[\d,.]*/gu) || []).map((value) => value.replace(/[,.]$/u, ""));
const ratio = (hits, total) => (total ? Number((hits / total).toFixed(4)) : null);

function evaluateConversations(conversations = []) {
  const counts = { turns: 0, repeated: 0, questionTurns: 0, unsupported: 0, handoffTurns: 0, handoffTruthful: 0, bookingTurns: 0, bookingTruthful: 0,
    correctionTurns: 0, correctionKept: 0, followupTurns: 0, followupOk: 0, answerableTurns: 0, unnecessaryClarifications: 0,
    numericTurns: 0, grounded: 0, llmCalls: 0, latencyMs: 0, answerChars: 0 };
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    const earlierQuestions = [];
    for (const turn of Array.isArray(conversation?.turns) ? conversation.turns : []) {
      const reply = String(turn?.reply || "");
      counts.turns += 1;
      counts.llmCalls += Number(turn?.llmCalls) || 0;
      counts.latencyMs += Number(turn?.latencyMs) || 0;
      counts.answerChars += reply.length;
      const questions = splitSentences(reply).filter(isQuestionText);
      if (questions.length) {
        counts.questionTurns += 1;
        if (questions.some((question) => earlierQuestions.some((earlier) => similar(earlier, question)))) counts.repeated += 1;
      }
      earlierQuestions.push(...questions);
      const evidence = (Array.isArray(turn?.evidence) ? turn.evidence : []).map((content) => ({ content: String(content) }));
      const { findings } = findUnsupportedActionClaims(reply, { actionState: { handoff: { status: turn?.handoffState || "not_requested" },
        booking: { status: turn?.bookingState || "none" }, leadSaved: turn?.leadSaved === true }, evidenceItems: evidence });
      if (findings.length) counts.unsupported += 1;
      counts.handoffTurns += 1;
      if (!findings.some((finding) => HANDOFF_CODES.has(finding.code))) counts.handoffTruthful += 1;
      counts.bookingTurns += 1;
      if (!findings.some((finding) => BOOKING_CODES.has(finding.code))) counts.bookingTruthful += 1;
      const corrected = Array.isArray(turn?.correctedNames) ? turn.correctedNames.filter(Boolean) : [];
      if (corrected.length) {
        counts.correctionTurns += 1;
        if (!corrected.some((name) => containsWord(reply, name))) counts.correctionKept += 1;
      }
      const mustMention = Array.isArray(turn?.expect?.mustMention) ? turn.expect.mustMention : [];
      if (mustMention.length) {
        counts.followupTurns += 1;
        if (mustMention.every((value) => normalize(reply).includes(normalize(value)))) counts.followupOk += 1;
      }
      if (turn?.expect?.answerable === true) {
        counts.answerableTurns += 1;
        const sentences = splitSentences(reply);
        if (sentences.length && sentences.every(isQuestionText)) counts.unnecessaryClarifications += 1;
      }
      const numbers = numbersIn(reply);
      if (numbers.length) {
        counts.numericTurns += 1;
        const evidenceText = evidence.map((item) => item.content).join("\n");
        if (numbers.every((value) => evidenceText.includes(value))) counts.grounded += 1;
      }
    }
  }
  return {
    conversations: Array.isArray(conversations) ? conversations.length : 0,
    turns: counts.turns,
    rates: {
      repeatedQuestionRate: ratio(counts.repeated, counts.questionTurns),
      unsupportedClaimRate: ratio(counts.unsupported, counts.turns),
      correctionRetention: ratio(counts.correctionKept, counts.correctionTurns),
      followupContextSuccess: ratio(counts.followupOk, counts.followupTurns),
      unnecessaryClarificationRate: ratio(counts.unnecessaryClarifications, counts.answerableTurns),
      handoffTruthfulness: ratio(counts.handoffTruthful, counts.handoffTurns),
      bookingTruthfulness: ratio(counts.bookingTruthful, counts.bookingTurns),
      factualGroundingRate: ratio(counts.grounded, counts.numericTurns)
    },
    averages: {
      llmCallsPerTurn: counts.turns ? Number((counts.llmCalls / counts.turns).toFixed(3)) : 0,
      latencyMs: counts.turns ? Math.round(counts.latencyMs / counts.turns) : 0,
      answerChars: counts.turns ? Math.round(counts.answerChars / counts.turns) : 0
    },
    counts
  };
}

const SAMPLE = [
  { id: "sample-good", turns: [
    { customer: "Hi, my name is Sami", reply: "Hello Sami, I am REFAL. How can I help?", llmCalls: 2 },
    { customer: "My name is not Sami, it is Hassan", reply: "Sorry about that, Hassan. How can I help with your company plans?", llmCalls: 3, correctedNames: ["Sami"] },
    { customer: "How much is the package?", reply: "The company formation package costs 1,950 EUR excluding VAT.", llmCalls: 4, correctedNames: ["Sami"],
      evidence: ["The company formation package costs 1,950 EUR excluding VAT."], expect: { answerable: true } },
    { customer: "Can a specialist contact me?", reply: "Your request is not connected to the team yet. Would you like me to submit it?", llmCalls: 3, handoffState: "requested", correctedNames: ["Sami"] }
  ] },
  { id: "sample-bad", turns: [
    { customer: "Can a specialist contact me?", reply: "A specialist has been notified and will reply shortly.", llmCalls: 3, handoffState: "requested" },
    { customer: "How much is the package?", reply: "It is 900 EUR. Anything else?", llmCalls: 3, expect: { answerable: true } }
  ] }
];

if (require.main === module) {
  const file = process.argv[2];
  const conversations = file ? JSON.parse(fs.readFileSync(file, "utf8")) : SAMPLE;
  process.stdout.write(`${JSON.stringify(evaluateConversations(conversations), null, 2)}\n`);
}

module.exports = { evaluateConversations, SAMPLE };
