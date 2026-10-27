import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runSyntheticAgentLoad, parseArgs, percentile } = require("./runSyntheticAgentLoad.js");

test("keeps each synthetic contact's turns ordered and covers all three languages", async () => {
  const report = await runSyntheticAgentLoad({ count: 18, concurrency: 4, queue: 30 });
  assert.equal(report.label, "SYNTHETIC / MOCKED LOAD ONLY");
  assert.equal(report.evidenceClass, "synthetic");
  assert.equal(report.productionMeasurements, false);
  assert.match(report.disclaimer, /not a production-readiness claim/);
  assert.deepEqual(new Set(report.languageOrder.map((turn) => turn.language)), new Set(["en", "ar", "el"]));
  const byContact = new Map();
  for (const turn of report.languageOrder) {
    const list = byContact.get(turn.contact) || [];
    list.push(turn.index);
    byContact.set(turn.contact, list);
  }
  for (const indices of byContact.values()) assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  assert.equal(report.results.completed, 18);
  assert.equal(report.finalExecutorStats.active, 0);
  assert.equal(report.finalExecutorStats.queued, 0);
});

test("records overloads when the executor waiting queue is bounded", async () => {
  const report = await runSyntheticAgentLoad({ count: 24, concurrency: 1, queue: 0 });
  assert.ok(report.results.failed > 0);
  assert.equal(report.results.queueRejected, report.results.failed);
  assert.equal(report.failuresByStage.queue, report.results.failed);
  assert.ok(report.results.completed > 0);
  assert.ok(report.results.failed + report.results.completed === 24);
  assert.ok(report.peakConcurrency <= 1);
  assert.equal(report.finalExecutorStats.queued, 0);
});

test("injects retrieval, model, provider, database, and WhatsApp failures locally", async () => {
  for (const stage of ["retrieval", "model", "provider", "database", "whatsapp"]) {
    const report = await runSyntheticAgentLoad({ count: 6, concurrency: 3, queue: 10, failures: [stage] });
    assert.equal(report.results.failed, 1, stage);
    assert.equal(report.failuresByStage[stage], 1, stage);
    assert.match(report.disclaimer, /No provider, database, live retrieval, WhatsApp, or network calls/);
  }
});

test("applies every requested failure stage once when several are injected together", async () => {
  const stages = ["retrieval", "model", "provider", "database", "whatsapp"];
  const report = await runSyntheticAgentLoad({ count: 30, concurrency: 5, queue: 40, failures: stages });
  for (const stage of stages) assert.equal(report.failuresByStage[stage], 1, stage);
  assert.equal(report.results.failed, stages.length);
  assert.equal(report.results.completed + report.results.failed, 30);
});

test("counts duplicate local action attempts and reports bounded latency metrics", async () => {
  const report = await runSyntheticAgentLoad({ count: 12, concurrency: 3, queue: 20 });
  assert.ok(report.duplicateActionAttempts > 0);
  assert.ok(report.simulatedActionEffects > 0);
  for (const key of ["queueP50", "queueP95", "turnP50", "turnP95"]) {
    assert.ok(Number.isFinite(report.metricsMs[key]));
    assert.ok(report.metricsMs[key] >= 0);
  }
  assert.ok(report.metricsMs.queueP95 >= report.metricsMs.queueP50);
  assert.ok(report.metricsMs.turnP95 >= report.metricsMs.turnP50);
});

test("parses load options and percentile uses nearest-rank selection", async () => {
  assert.deepEqual(parseArgs(["--count", "9", "--concurrency=2", "--queue", "4", "--fail", "model,database"]), {
    count: 9, concurrency: 2, queue: 4, failures: ["model", "database"]
  });
  assert.equal(percentile([1, 4, 2, 3], 0.5), 2);
  assert.throws(() => parseArgs(["--wat", "3"]), /Unknown option/);
  assert.throws(() => parseArgs(["--count", "--queue", "2"]), /Missing value for --count/);
  assert.throws(() => parseArgs(["--count", "1000000000"]), /integer from 1 to 10000/);
  await assert.rejects(runSyntheticAgentLoad({ count: 2.5 }), /integer from 1 to 10000/);
});
