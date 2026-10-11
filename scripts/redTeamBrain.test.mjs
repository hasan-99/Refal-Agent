import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { RED_TEAM_CORPUS, RED_TEAM_CATEGORIES, RED_TEAM_LANGUAGES } = require("../src/redTeamCorpus.js");
const { runRedTeamBrain } = require("./redTeamBrain.js");

test("P11.4 round one covers the complete corpus across every category and language", () => {
  const report = runRedTeamBrain();
  assert.equal(report.coverage.corpusCases, 200);
  assert.equal(RED_TEAM_CORPUS.length, 200);
  assert.deepEqual(Object.keys(report.coverage.byCategory).sort(), [...RED_TEAM_CATEGORIES].sort());
  assert.deepEqual(Object.keys(report.coverage.byLanguage).sort(), [...RED_TEAM_LANGUAGES].sort());
  for (const language of RED_TEAM_LANGUAGES) assert.ok(report.coverage.byLanguage[language] > 0, `${language} coverage`);
  for (const category of RED_TEAM_CATEGORIES) {
    assert.ok(report.coverage.byCategory[category].total > 0, `${category} coverage`);
    for (const language of RED_TEAM_LANGUAGES) {
      assert.ok(report.coverage.byCategory[category].byLanguage[language] > 0, `${category}/${language} coverage`);
    }
  }
  assert.match(report.limitation, /not a live-model robustness evaluation/);
  assert.match(report.mode, /no provider, network, database/);
});

test("all expected deterministic request blocks and answer probes have zero missed blocks", () => {
  const report = runRedTeamBrain();
  assert.deepEqual(report.coverage.requestMisses, []);
  assert.deepEqual(report.coverage.answerMisses, []);
  assert.equal(report.cases.length, 200);
  for (const entry of report.cases) {
    assert.equal(entry.answerProbes.length, 2, `${entry.id}: both forbidden-output probes were checked`);
    for (const probe of entry.answerProbes) assert.ok(probe.violations.length > 0, `${entry.id}/${probe.probe}: no deterministic block reason`);
  }
  assert.equal(report.passed, true);
});

test("the report contains only fixture identifiers and detector codes, never raw fixture text", () => {
  const reportText = JSON.stringify(runRedTeamBrain());
  for (const entry of RED_TEAM_CORPUS) {
    assert.equal(reportText.includes(entry.text), false, `${entry.id} raw request leaked`);
    for (const output of entry.mustNotProduce) assert.equal(reportText.includes(output), false, `${entry.id} raw output leaked`);
  }
  assert.doesNotMatch(reportText, /41223344|7741920/);
});
