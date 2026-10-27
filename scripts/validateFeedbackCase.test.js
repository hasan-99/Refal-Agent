"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateFeedbackCase, hasPiiLikeText } = require("./validateFeedbackCase");

const captured = {
  caseId: "FB-2026-0001", capturedAt: "2026-10-11T09:30:00Z",
  signal: "unanswered_question", language: "ar", topic: "banking-and-payment-gateways",
  severity: "normal", summary: "Arabic answer did not explain who decides account approval.",
  observedBehavior: "The reply gave a generic fallback despite relevant approved guidance.",
  expectedBehavior: "State the bank makes the final decision and ask one useful activity question.",
  evidenceRef: "restricted-case:opaque-7f31", status: "captured"
};

test("feedback capture accepts a minimized, multilingual, pseudonymous case", () => {
  assert.deepEqual(validateFeedbackCase(captured), []);
});

test("feedback record rejects raw customer fields, unknown fields, and contact or secret text", () => {
  const errors = validateFeedbackCase({ ...captured, customerText: "please store this", summary: "Call me at +357 99123456" }).join("\n");
  assert.match(errors, /customerText is prohibited/u);
  assert.match(errors, /summary contains email, phone-like, or secret-like content/u);
  assert.match(validateFeedbackCase({ ...captured, arbitrary: "text" }).join(" "), /not an allowed feedback field/u);
  assert.match(validateFeedbackCase({ ...captured, triage: { reviewer: "QA", customerId: "123" } }).join(" "), /triage.customerId is prohibited/u);
  assert.equal(hasPiiLikeText("api key: hiddenvalue"), true);
});

test("feedback privacy scan catches Unicode phone digits and bearer credentials", () => {
  assert.equal(hasPiiLikeText("اتصل بي على ٠٥٠١٢٣٤٥٦٧"), true);
  assert.equal(hasPiiLikeText("راسلني على ۰۹۱۲۳۴۵۶۷۸"), true);
  assert.equal(hasPiiLikeText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"), true);
  assert.match(validateFeedbackCase({ ...captured, summary: "اتصل بي على ٠٥٠١٢٣٤٥٦٧" }).join(" "), /phone-like/u);
});

test("feedback IDs and references cannot carry obvious PII or secret text", () => {
  assert.match(validateFeedbackCase({ ...captured, caseId: "hasan@example.com" }).join(" "), /opaque FB-YYYY-NNNN/u);
  assert.match(validateFeedbackCase({ ...captured, caseId: "FB-2026-35799123456" }).join(" "), /opaque FB-YYYY-NNNN/u);
  assert.match(validateFeedbackCase({ ...captured, topic: "customer 99123456" }).join(" "), /approved knowledge taxonomy slug/u);
  const released = {
    ...captured, status: "change_released", triage: { reviewer: "Reviewer", decision: "fix" },
    testCase: { id: "REG-1", path: "src/example.test.js", command: "node --test", result: "passed", reviewedBy: "QA" },
    changeRef: "secret key: abc123"
  };
  assert.match(validateFeedbackCase(released).join(" "), /changeRef contains email, phone-like, or secret-like content/u);
});

test("feedback evidence references must be opaque restricted-case identifiers", () => {
  assert.deepEqual(validateFeedbackCase(captured), []);
  const errors = validateFeedbackCase({ ...captured, evidenceRef: "WhatsApp thread for customer Hasan Haddad" }).join(" ");
  assert.match(errors, /evidenceRef must be a restricted-case opaque identifier/u);
  assert.match(validateFeedbackCase({ ...captured, evidenceRef: "restricted-case:opaque-x" }).join(" "), /opaque identifier/u);
});

test("feedback capture timestamps must represent a real calendar date and time", () => {
  assert.match(validateFeedbackCase({ ...captured, capturedAt: "2026-99-99T99:99:99Z" }).join(" "), /real ISO UTC timestamp/u);
  assert.deepEqual(validateFeedbackCase({ ...captured, capturedAt: "2026-10-11T09:30:00.125Z" }), []);
});

test("review dispositions require a named reviewer and rationale for non-actionable cases", () => {
  const missingReviewer = validateFeedbackCase({ ...captured, status: "triaged", triage: { decision: "fix" } }).join(" ");
  assert.match(missingReviewer, /triage.reviewer is required/u);
  const noRationale = validateFeedbackCase({ ...captured, status: "non_actionable", triage: { reviewer: "Reviewer", decision: "close" } }).join(" ");
  assert.match(noRationale, /triage.rationale is required/u);
});

test("a fix cannot advance to knowledge or prompt change before a passed regression case", () => {
  const noTest = validateFeedbackCase({ ...captured, status: "test_added", triage: { reviewer: "Reviewer", decision: "fix" } }).join(" ");
  assert.match(noTest, /testCase is required before/u);
  const failing = {
    ...captured, status: "test_added", triage: { reviewer: "Reviewer", decision: "fix" },
    testCase: { id: "REG-1", path: "src/example.test.js", command: "node --test", result: "failed", reviewedBy: "QA" }
  };
  assert.match(validateFeedbackCase(failing).join(" "), /result must be 'passed'/u);
  assert.deepEqual(validateFeedbackCase({ ...failing, testCase: { ...failing.testCase, result: "passed" } }), []);
});

test("released changes require a passing test record and traceable change reference", () => {
  const record = {
    ...captured, status: "change_released", triage: { reviewer: "Reviewer", decision: "fix" },
    testCase: { id: "REG-1", path: "src/example.test.js", command: "node --test src/example.test.js", result: "passed", reviewedBy: "QA" }
  };
  assert.match(validateFeedbackCase(record).join(" "), /changeRef is required/u);
  assert.deepEqual(validateFeedbackCase({ ...record, changeRef: "commit-or-release-id" }), []);
});

test("feedback status and language values are constrained", () => {
  const errors = validateFeedbackCase({ ...captured, language: "fr", status: "approved" }).join(" ");
  assert.match(errors, /language must be en, ar, el, mixed, or unknown/u);
  assert.match(errors, /status must be one of/u);
});
