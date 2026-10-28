import test from "node:test";
import assert from "node:assert/strict";
import { summarizeManualEvidenceFacts } from "./factRegisterProvenance.js";

test("manual-only provenance summary keeps pending facts visible and counts approved states separately", () => {
  const sourceDocument = "newplan/Master Brain & Operating Rules Manual - REFAL AI.txt";
  const summary = summarizeManualEvidenceFacts([
    { id: "MB-1", status: "pending", sourceDocument },
    { id: "MB-2", status: "approved", sourceDocument },
    { id: "MB-3", status: "blocked", sourceDocument },
    { id: "MB-4", status: "approved", sourceDocument: "https://www.gov.cy/current" },
  ]);
  assert.deepEqual(summary.facts.map(({ id }) => id), ["MB-1", "MB-2", "MB-3"]);
  assert.equal(summary.pending, 1);
  assert.equal(summary.approved, 1);
});

test("manual-only provenance summary handles missing and malformed fact lists", () => {
  assert.deepEqual(summarizeManualEvidenceFacts(null), { facts: [], approved: 0, pending: 0 });
  assert.deepEqual(summarizeManualEvidenceFacts([
    { id: "MB-1", status: "pending", sourceDocument: null },
    null,
  ]), { facts: [], approved: 0, pending: 0 });
});
