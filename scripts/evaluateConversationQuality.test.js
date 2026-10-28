"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { evaluateConversations, SAMPLE } = require("./evaluateConversationQuality");

test("rates separate a truthful conversation from one with false handoff, repeated questions and invented prices", () => {
  const good = evaluateConversations([SAMPLE[0]]);
  assert.equal(good.rates.handoffTruthfulness, 1);
  assert.equal(good.rates.unsupportedClaimRate, 0);
  assert.equal(good.rates.correctionRetention, 1);
  assert.equal(good.rates.factualGroundingRate, 1);
  const bad = evaluateConversations([SAMPLE[1]]);
  assert.equal(bad.rates.handoffTruthfulness, 0.5);
  assert.equal(bad.rates.unsupportedClaimRate, 0.5);
  assert.equal(bad.rates.factualGroundingRate, 0);
  assert.equal(bad.averages.llmCallsPerTurn, 3);
});

test("repeated questions, unnecessary clarifications, follow-up context and booking truthfulness", () => {
  const report = evaluateConversations([{ id: "x", turns: [
    { customer: "hi", reply: "Hello. Which country are you based in?" },
    { customer: "Cyprus", reply: "Thanks. Which country are you based in?", expect: { mustMention: ["Cyprus"] } },
    { customer: "What does it include?", reply: "What do you mean?", expect: { answerable: true } },
    { customer: "Book me", reply: "Your meeting is confirmed for Monday.", bookingState: "pending_confirmation" }
  ] }]);
  assert.equal(report.rates.repeatedQuestionRate, 0.3333);
  assert.equal(report.rates.followupContextSuccess, 0);
  assert.equal(report.rates.unnecessaryClarificationRate, 1);
  assert.equal(report.rates.bookingTruthfulness, 0.75);
  assert.equal(report.rates.correctionRetention, null, "not applicable without a correction");
});

test("CLI prints a JSON report for the built-in sample", () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, "evaluateConversationQuality.js")], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.conversations, 2);
  assert.equal(typeof report.rates.handoffTruthfulness, "number");
});
