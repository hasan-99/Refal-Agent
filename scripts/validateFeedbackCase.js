"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TOPICS } = require("../src/brainTaxonomy");

const SIGNALS = new Set([
  "customer_correction", "unanswered_question", "retrieval_miss",
  "tool_failure", "complaint", "staff_edit"
]);
const STATUSES = new Set(["captured", "triaged", "non_actionable", "test_added", "change_released"]);
const LANGUAGES = new Set(["en", "ar", "el", "mixed", "unknown"]);
const TOPIC_SLUGS = new Set(TOPICS.map((topic) => topic.slug));
const ALLOWED_KEYS = new Set([
  "caseId", "capturedAt", "signal", "language", "topic", "severity",
  "summary", "observedBehavior", "expectedBehavior", "evidenceRef",
  "status", "triage", "testCase", "changeRef"
]);
const NESTED_ALLOWED_KEYS = {
  triage: new Set(["reviewer", "decision", "rationale"]),
  testCase: new Set(["id", "path", "command", "result", "reviewedBy"])
};
const RAW_DATA_KEYS = /^(customerText|rawMessage|transcript|conversation|phone|email|name|customerId|contact|accountId|credentials|secret)$/iu;
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?\p{N}[\p{N}\s().\-\u066B\u066C]*){8,}/u,
  /\b(?:password|access token|api key|secret key)\s*[:=]/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu
];

function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function hasPiiLikeText(value) { return PII_PATTERNS.some((pattern) => pattern.test(String(value))); }

function validateFeedbackCase(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["Feedback case must be a JSON object."];
  for (const key of Object.keys(record)) {
    if (RAW_DATA_KEYS.test(key)) errors.push(`${key} is prohibited; store no raw customer or secret data.`);
    else if (!ALLOWED_KEYS.has(key)) errors.push(`${key} is not an allowed feedback field.`);
  }
  for (const [objectName, allowed] of Object.entries(NESTED_ALLOWED_KEYS)) {
    const nested = record[objectName];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const key of Object.keys(nested)) {
        if (RAW_DATA_KEYS.test(key)) errors.push(`${objectName}.${key} is prohibited; store no raw customer or secret data.`);
        else if (!allowed.has(key)) errors.push(`${objectName}.${key} is not an allowed feedback field.`);
      }
    }
  }
  for (const key of ["caseId", "capturedAt", "signal", "language", "topic", "severity", "summary", "observedBehavior", "expectedBehavior", "evidenceRef", "status"]) {
    if (!nonEmpty(record[key])) errors.push(`${key} is required.`);
  }
  if (nonEmpty(record.signal) && !SIGNALS.has(record.signal)) errors.push(`signal must be one of: ${[...SIGNALS].join(", ")}.`);
  if (nonEmpty(record.language) && !LANGUAGES.has(record.language)) errors.push("language must be en, ar, el, mixed, or unknown.");
  if (nonEmpty(record.caseId) && !/^FB-\d{4}-\d{4}$/u.test(record.caseId)) errors.push("caseId must be an opaque FB-YYYY-NNNN identifier.");
  if (nonEmpty(record.topic) && !TOPIC_SLUGS.has(record.topic)) errors.push("topic must be an approved knowledge taxonomy slug.");
  if (nonEmpty(record.evidenceRef) && !/^restricted-case:opaque-[a-z0-9][a-z0-9_-]{3,63}$/iu.test(record.evidenceRef)) {
    errors.push("evidenceRef must be a restricted-case opaque identifier, not a customer name, transcript, or free-text locator.");
  }
  if (nonEmpty(record.severity) && !["low", "normal", "high", "urgent"].includes(record.severity)) errors.push("severity must be low, normal, high, or urgent.");
  if (nonEmpty(record.status) && !STATUSES.has(record.status)) errors.push(`status must be one of: ${[...STATUSES].join(", ")}.`);
  if (nonEmpty(record.capturedAt)) {
    const timestamp = record.capturedAt;
    const timestampShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(timestamp);
    const parsed = timestampShape ? new Date(timestamp) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== timestamp.slice(0, 19)) {
      errors.push("capturedAt must be a real ISO UTC timestamp.");
    }
  }
  for (const key of ["summary", "observedBehavior", "expectedBehavior", "evidenceRef", "changeRef"]) {
    if (nonEmpty(record[key]) && hasPiiLikeText(record[key])) errors.push(`${key} contains email, phone-like, or secret-like content; redact it and reference restricted evidence by opaque ID.`);
  }
  for (const [objectName, allowed] of Object.entries(NESTED_ALLOWED_KEYS)) {
    const nested = record[objectName];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const key of allowed) {
        if (nonEmpty(nested[key]) && hasPiiLikeText(nested[key])) errors.push(`${objectName}.${key} contains email, phone-like, or secret-like content.`);
      }
    }
  }
  if (record.triage !== undefined && (!record.triage || typeof record.triage !== "object" || Array.isArray(record.triage))) errors.push("triage must be an object when present.");
  if (["triaged", "non_actionable", "test_added", "change_released"].includes(record.status)) {
    if (!nonEmpty(record.triage?.reviewer)) errors.push("triage.reviewer is required after capture.");
    if (!nonEmpty(record.triage?.decision)) errors.push("triage.decision is required after capture.");
  }
  if (record.status === "non_actionable" && !nonEmpty(record.triage?.rationale)) errors.push("triage.rationale is required to close feedback as non-actionable.");
  if (["test_added", "change_released"].includes(record.status)) {
    const test = record.testCase;
    if (!test || typeof test !== "object" || Array.isArray(test)) errors.push("testCase is required before a proposed fix can advance.");
    else {
      for (const key of ["id", "path", "command", "result", "reviewedBy"]) if (!nonEmpty(test[key])) errors.push(`testCase.${key} is required.`);
      if (test.result !== "passed") errors.push("testCase.result must be 'passed' before a knowledge or prompt change.");
    }
  }
  if (record.status === "change_released" && !nonEmpty(record.changeRef)) errors.push("changeRef is required after release.");
  return errors;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    process.stderr.write("Usage: node scripts/validateFeedbackCase.js <feedback-case.json>\n");
    return 2;
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv[0]), "utf8")); }
  catch (error) { process.stderr.write(`Invalid feedback case JSON: ${error.message}\n`); return 2; }
  const errors = validateFeedbackCase(record);
  if (errors.length) { for (const error of errors) process.stderr.write(`FAIL ${error}\n`); return 1; }
  process.stdout.write(`PASS feedback case ${record.caseId} is structurally valid at status ${record.status}; human review and full regression gates still apply.\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { validateFeedbackCase, main, hasPiiLikeText };
