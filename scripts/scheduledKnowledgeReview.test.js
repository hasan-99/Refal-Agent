"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, buildReport, run } = require("./scheduledKnowledgeReview");
const { seedRegister, applyOverrides, STATUS } = require("../src/factRegister");

test("review reports an explicit freshness measure and does not call pending facts current", () => {
  const report = buildReport({ now: "2026-10-11", owner: "Knowledge Owner", reviewer: "Independent Reviewer" });
  assert.equal(report.freshness.total, 82);
  assert.equal(report.freshness.current, 0);
  assert.equal(report.facts.pending.count, 82);
  assert.equal(report.status, "REVIEW_REQUIRED");
  assert.match(report.source, /live database not inspected/u);
  assert.equal(report.rollback.available, false);
});

test("source changes become due immediately and unknown IDs are surfaced", () => {
  const report = buildReport({ now: "2026-10-11", owner: "Owner", reviewer: "Reviewer", sourceChanged: ["MB-F19", "NOT-A-FACT"] });
  assert.deepEqual(report.sourceChanges.dueNow, ["MB-F19"]);
  assert.deepEqual(report.sourceChanges.unknownIds, ["NOT-A-FACT"]);
  assert.equal(report.status, "REVIEW_REQUIRED");
});

test("review owner and independent reviewer are required for a green status", () => {
  const report = buildReport({ now: "2026-10-11" });
  assert.equal(report.accountableOwner, null);
  assert.equal(report.independentReviewer, null);
  assert.ok(report.blockingFindings >= 2);
});

test("blocked facts count as a scheduled-review blocker", () => {
  const register = applyOverrides(seedRegister(), [{ id: "MB-F19", status: STATUS.BLOCKED }]);
  const report = buildReport({ now: "2026-10-11", owner: "Owner", reviewer: "Reviewer", register });
  assert.equal(report.facts.blocked.count, 1);
  assert.deepEqual(report.facts.blocked.ids, ["MB-F19"]);
  assert.equal(report.status, "REVIEW_REQUIRED");
});

test("the accountable owner cannot also serve as independent reviewer", () => {
  const samePerson = buildReport({ now: "2026-10-11", owner: "Knowledge Owner", reviewer: " knowledge   owner " });
  const separatePeople = buildReport({ now: "2026-10-11", owner: "Knowledge Owner", reviewer: "Independent Reviewer" });
  assert.equal(samePerson.reviewerIndependenceConflict, true);
  assert.equal(separatePeople.reviewerIndependenceConflict, false);
  assert.equal(samePerson.blockingFindings, separatePeople.blockingFindings + 1);
  assert.equal(samePerson.status, "REVIEW_REQUIRED");
});

test("scheduled review catches punctuation, accent, and initial variants of the same reviewer name", () => {
  for (const [owner, reviewer] of [
    ["A. Smith", "A Smith"],
    ["José García", "Jose Garcia"],
    ["Hassan Ahmad", "H. Ahmad"]
  ]) {
    const report = buildReport({ now: "2026-10-11", owner, reviewer });
    assert.equal(report.reviewerIndependenceConflict, true, `${owner} / ${reviewer}`);
    assert.equal(report.status, "REVIEW_REQUIRED");
  }
  assert.equal(buildReport({ now: "2026-10-11", owner: "Ann Smith", reviewer: "Annette Smith" }).reviewerIndependenceConflict, false);
});

test("bad CLI arguments fail closed", () => {
  assert.throws(() => parseArgs(["--now", "2026-02-30"]), /YYYY-MM-DD/u);
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/u);
  assert.equal(run(["--source-changed"]), 2);
});
