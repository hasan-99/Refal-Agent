"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CASES, READ_ONLY_TOOLS, evaluateCase, hasCurrentOfferLookup, buildReport } = require("./evaluateApprovedOfferAnswers");

const currentOffer = {
  tool: "lookupActiveOffer",
  result: { status: "found", modelObservation: {
    type: "dynamic_data", source: "trusted_edge_dynamic_read",
    records: [{ code: "formation-package", reviewStatus: "approved", active: true, validUntil: "2099-01-01T00:00:00Z" }]
  } }
};

test("live offer smoke contains exactly three synthetic language cases and only read tools", () => {
  assert.deepEqual(CASES.map((item) => item.language), ["english", "arabic", "greek"]);
  assert.deepEqual(Object.keys(READ_ONLY_TOOLS).sort(), ["lookupActiveOffer", "searchApprovedKnowledge"]);
  assert.equal(Object.values(READ_ONLY_TOOLS).every(Boolean), true);
  assert.deepEqual(CASES.map((item) => item.id), ["formation_offer_price_en", "formation_offer_price_ar", "formation_offer_price_el"]);
});

test("live smoke report records its limited scope without answer text or customer data", () => {
  const report = buildReport([{ language: "english", status: "PASS", response: "private answer text", responseLength: 123,
    toolsUsed: ["lookupActiveOffer"], currentApprovedOfferObserved: true, responsePolicyValid: true, errors: [] }], "2026-10-11T00:00:00.000Z");
  assert.deepEqual(report.summary, { total: 1, passed: 1, failed: 0 });
  assert.equal(report.scope.realCustomerData, false);
  assert.equal(report.scope.contactWrites, false);
  assert.equal(report.scope.customerSends, false);
  assert.equal(report.scope.deployedEdgeRuntime, false);
  assert.equal("response" in report.results[0], false);
});

test("current-offer evidence requires approved active live tool metadata and future expiry", () => {
  assert.equal(hasCurrentOfferLookup({ steps: [currentOffer] }), true);
  assert.equal(hasCurrentOfferLookup({ steps: [{ ...currentOffer, result: { ...currentOffer.result, status: "unavailable" } }] }), false);
  assert.equal(hasCurrentOfferLookup({ steps: [{ ...currentOffer, result: { ...currentOffer.result, modelObservation: { ...currentOffer.result.modelObservation, source: "fixture" } } }] }), false);
});

test("answer smoke passes only a localized response with current approved evidence and output-policy approval", async () => {
  const result = await evaluateCase(CASES[0], 0, {
    store: {},
    runTurn: async (_input, options) => {
      assert.deepEqual(Object.keys(options.tools).sort(), ["lookupActiveOffer", "searchApprovedKnowledge"]);
      return { outcome: "responded", response: "The current package covers company formation support. What activity will your company have?", toolsUsed: ["lookupActiveOffer"], steps: [currentOffer] };
    }
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.currentApprovedOfferObserved, true);
  assert.equal(result.responsePolicyValid, true);
});

test("answer smoke fails closed when live evidence is missing or a write tool was selected", async () => {
  const missingEvidence = await evaluateCase(CASES[0], 0, {
    store: {},
    runTurn: async () => ({ outcome: "responded", response: "I don't have approved information to confirm that yet.", toolsUsed: [], steps: [] })
  });
  assert.equal(missingEvidence.status, "FAIL");
  assert.ok(missingEvidence.errors.includes("approved_current_offer_not_observed"));

  const wrongTool = await evaluateCase(CASES[0], 0, {
    store: {},
    runTurn: async () => ({ outcome: "responded", response: "The current package covers company formation support. What activity will your company have?", toolsUsed: ["createHandover"], steps: [currentOffer] })
  });
  assert.ok(wrongTool.errors.includes("non_read_only_tool_used"));
});
