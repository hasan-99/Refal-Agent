"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, checkLiveOptionError, liveParityNeedsReview, applyExitCode } = require("./ingestBrainCorpus");

test("live corpus parity is explicitly read-only and requires the full corpus", () => {
  const args = parseArgs(["--check-live"]);
  assert.equal(args.checkLive, true);
  assert.equal(checkLiveOptionError(args), null);
  assert.match(checkLiveOptionError(parseArgs(["--check-live", "--apply"])), /read-only/);
  assert.match(checkLiveOptionError(parseArgs(["--check-live", "--lang", "en"])), /complete corpus/);
  assert.match(checkLiveOptionError(parseArgs(["--check-live", "--allow-partial"])), /complete corpus/);
});

test("live parity exits nonzero for content mismatch, expiry, or unresolved revisions", () => {
  assert.equal(liveParityNeedsReview({ counts: { match: 87 } }), false);
  assert.equal(liveParityNeedsReview({ counts: { match: 86, hash_mismatch: 1 } }), true);
  assert.equal(liveParityNeedsReview({ counts: { match: 87, expired: 1 } }), true);
  assert.equal(liveParityNeedsReview({ counts: { match: 87, pendingRevisions: 1 } }), true);
  assert.equal(liveParityNeedsReview({ counts: { match: 86, local_suppressed: 1 } }), true);
  assert.equal(liveParityNeedsReview({ counts: { match: 87, multipleApproved: 1 } }), true);
});

test("an apply with any embedding failure exits nonzero even when revision read-back matched", () => {
  assert.equal(applyExitCode({ mismatches: [], embedWarnings: [] }), 0);
  assert.equal(applyExitCode({ mismatches: ["hash mismatch"], embedWarnings: [] }), 1);
  assert.equal(applyExitCode({ mismatches: [], embedWarnings: ["provider timeout"] }), 1);
  assert.equal(applyExitCode({ mismatches: [], embedWarnings: [], skippedFiles: [{ suppressed: true }] }), 1);
});
