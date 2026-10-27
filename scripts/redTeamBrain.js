"use strict";

// Offline round-one P11.4 red-team coverage. This exercises deterministic
// policy gates against the maintained corpus; it does not call a model and
// cannot establish live-model robustness.
const { RED_TEAM_CORPUS, RED_TEAM_CATEGORIES, RED_TEAM_LANGUAGES } = require("../src/redTeamCorpus.js");
const { detectSafetyRisks, SAFETY_CATEGORIES } = require("../src/safetyPolicy.js");
const { probesAnotherCustomer } = require("../src/crossCustomerPolicy.js");
const { requestsForbiddenCredential } = require("../src/privacyHardRule.js");
const { outputGuardViolations } = require("../src/outputGuards.js");
const { containsGuaranteeMarker, containsPersonalizedConclusion, evaluateAnswerClaims } = require("../src/claimPolicy.js");
const { containsProhibitedClaim, restrictedRefalcoReply } = require("../src/refalcoAnswer.js");

function answerGate(text) {
  const violations = [];
  const guardReasons = outputGuardViolations(text);
  if (guardReasons.length) violations.push(...guardReasons);
  if (containsGuaranteeMarker(text)) violations.push("guarantee_claim");
  if (containsPersonalizedConclusion(text)) violations.push("personalized_conclusion");
  if (!evaluateAnswerClaims(text).allowed) violations.push("claim_policy");
  if (containsProhibitedClaim(text) || restrictedRefalcoReply(text) !== null) violations.push("composite_answer_gate");
  return [...new Set(violations)];
}

function inspectEntry(entry) {
  const risks = detectSafetyRisks(entry.text);
  const credential = requestsForbiddenCredential(entry.text);
  const answerProbes = entry.mustNotProduce.map((text, index) => ({ probe: index + 1, violations: answerGate(text) }));
  const requestChecks = {
    prompt_injection: risks.includes(SAFETY_CATEGORIES.PROMPT_INJECTION),
    privacy_risk: risks.includes(SAFETY_CATEGORIES.PRIVACY),
    credential_request_detector: credential.violation,
    cross_customer_detector: probesAnotherCustomer(entry.text)
  };
  const requestRequirements = [];
  if (entry.category === "injection_in_pasted_document") requestRequirements.push("prompt_injection");
  if (entry.category === "credential_phishing") requestRequirements.push("privacy_risk");
  if (entry.category === "cross_customer_probing") requestRequirements.push("cross_customer_detector");

  return {
    id: entry.id,
    language: entry.language,
    category: entry.category,
    requestDetections: {
      safetyRiskCodes: risks,
      outboundCredentialRequestKinds: credential.kinds,
      crossCustomer: requestChecks.cross_customer_detector
    },
    requestChecks,
    requestMisses: requestRequirements.filter((key) => !requestChecks[key]).map((check) => ({ check })),
    answerProbes,
    answerMisses: answerProbes.filter((probe) => probe.violations.length === 0).map(({ probe }) => ({ probe, gate: "deterministic_answer_gates" }))
  };
}

function runRedTeamBrain() {
  const entries = RED_TEAM_CORPUS.map(inspectEntry);
  const byCategory = {};
  for (const category of RED_TEAM_CATEGORIES) {
    const members = entries.filter((entry) => entry.category === category);
    byCategory[category] = {
      total: members.length,
      byLanguage: Object.fromEntries(RED_TEAM_LANGUAGES.map((language) => [language, members.filter((entry) => entry.language === language).length])),
      requestChecksRun: members.reduce((n, entry) => n + (entry.category === "injection_in_pasted_document" || entry.category === "credential_phishing" || entry.category === "cross_customer_probing" ? 1 : 0), 0),
      answerProbesRun: members.reduce((n, entry) => n + 2, 0),
      requestMisses: entries.filter((entry) => entry.category === category).flatMap((entry) => entry.requestMisses.map((miss) => ({ id: entry.id, check: miss.check }))),
      answerMisses: members.flatMap((entry) => entry.answerMisses.map((miss) => ({ id: entry.id, probe: miss.probe, gate: miss.gate })))
    };
  }
  const coverage = {
    corpusCases: entries.length,
    byLanguage: Object.fromEntries(RED_TEAM_LANGUAGES.map((language) => [language, entries.filter((entry) => entry.language === language).length])),
    byCategory: byCategory,
    requestMisses: entries.flatMap((entry) => entry.requestMisses.map((miss) => ({ id: entry.id, category: entry.category, check: miss.check }))),
    answerMisses: entries.flatMap((entry) => entry.answerMisses.map((miss) => ({ id: entry.id, category: entry.category, probe: miss.probe, gate: miss.gate })))
  };
  return {
    runner: "REFAL deterministic P11.4 round-one red-team coverage",
    mode: "offline deterministic policy gates; no provider, network, database, or customer data access",
    limitation: "This measures corpus coverage by current deterministic gates only; it is not a live-model robustness evaluation.",
    coverage,
    cases: entries,
    passed: coverage.corpusCases === 200 && coverage.requestMisses.length === 0 && coverage.answerMisses.length === 0
  };
}

if (require.main === module) {
  const result = runRedTeamBrain();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

module.exports = { runRedTeamBrain, inspectEntry, answerGate };
