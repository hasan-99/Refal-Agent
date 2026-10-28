#!/usr/bin/env node
"use strict";

// Calibrates the Knowledge Gap grouping threshold on the labelled set in
// scripts/knowledgeGapCalibrationSet.js with the REAL local e5 embedding
// (src/ai.js embedText). Offline only: no network, no database.
//
//   node scripts/calibrateKnowledgeGapGrouping.js --local-models C:/Temp/refal-models [--out <dir>]
//
// Two measurements per threshold:
//   pairwise  every question pair, compatible categories only: precision /
//             recall of "same topic" vs cosine >= threshold
//   grouping  the production decision (decideGapGroup against running
//             centroids, the same update the SQL applies), over several
//             deterministic orderings; pairwise precision / recall of the
//             resulting groups against the labels
// The recommendation is the setting with the best mean recall among those
// whose WORST grouping precision over all orderings is 1.0 (never over-merge).
// The held-out set is then scored at the PRODUCTION setting, untuned.

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { KNOWLEDGE_GAP_CALIBRATION_QUESTIONS, KNOWLEDGE_GAP_HELD_OUT_QUESTIONS } = require("./knowledgeGapCalibrationSet");

function parseArgs(argv) {
  const args = { localModels: process.env.RAFA_LOCAL_MODEL_PATH || null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--local-models") args.localModels = argv[++i];
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

async function useLocalModels(dir) {
  const { env } = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href.replace(/transformers\.node\.cjs$/u, "transformers.node.mjs"));
  env.allowRemoteModels = false;
  env.localModelPath = dir;
}

function seededOrder(length, seed) {
  const order = Array.from({ length }, (_value, index) => index);
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function pairMetrics(assign, items) {
  let tp = 0; let fp = 0; let fn = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const same = items[i].topic === items[j].topic;
      const grouped = assign[i] === assign[j];
      if (same && grouped) tp += 1; else if (!same && grouped) fp += 1; else if (same && !grouped) fn += 1;
    }
  }
  return { precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1, falseMerges: fp };
}

function simulateGrouping(policy, items, order, config) {
  const groups = [];
  const assign = new Array(items.length);
  for (const index of order) {
    const item = items[index];
    const candidates = groups.map((group) => ({ id: group.id, similarity: policy.cosine(group.centroid, item.vector), category: group.category,
      reason: "missing_knowledge", facets: [...group.facets], objects: [...group.objects] }));
    const decision = policy.decideGapGroup({ category: item.category, reason: "missing_knowledge", aspects: item.aspects }, candidates, config);
    if (decision.groupId === null) {
      groups.push({ id: groups.length, centroid: item.vector, count: 1, category: item.category,
        facets: new Set(item.aspects.facets), objects: new Set(item.aspects.objects) });
      assign[index] = groups.length - 1;
    } else {
      const group = groups[decision.groupId];
      group.centroid = policy.updateCentroid(group.centroid, group.count, item.vector);
      group.count += 1;
      assign[index] = group.id;
    }
  }
  return assign;
}

async function prepare({ embed, policy, items }) {
  const prepared = [];
  for (const question of items) {
    const vector = policy.toUnitVector(await embed(question.text));
    prepared.push({ ...question, vector, category: policy.gapCategoryForIntents(question.intents).category, aspects: policy.questionAspects(question.text) });
  }
  return prepared;
}

function evaluateGrouping(policy, prepared, config, seeds) {
  const runs = seeds.map((seed) => pairMetrics(simulateGrouping(policy, prepared, seededOrder(prepared.length, seed), config), prepared));
  return { minPrecision: Math.min(...runs.map((r) => r.precision)), meanPrecision: runs.reduce((s, r) => s + r.precision, 0) / runs.length,
    meanRecall: runs.reduce((s, r) => s + r.recall, 0) / runs.length, minRecall: Math.min(...runs.map((r) => r.recall)),
    maxFalseMerges: Math.max(...runs.map((r) => r.falseMerges)) };
}

async function calibrate({ embed, policy, items = KNOWLEDGE_GAP_CALIBRATION_QUESTIONS, heldOut = KNOWLEDGE_GAP_HELD_OUT_QUESTIONS, seeds = [1, 2, 3, 4, 5, 6, 7, 8] } = {}) {
  const prepared = await prepare({ embed, policy, items });
  const pairs = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      pairs.push({ same: prepared[i].topic === prepared[j].topic, score: policy.cosine(prepared[i].vector, prepared[j].vector), a: prepared[i].id, b: prepared[j].id,
        compatible: policy.categoriesCompatible(prepared[i].category, prepared[j].category), aspects: policy.compareAspects(prepared[i].aspects, prepared[j].aspects) });
    }
  }
  const sweep = [];
  for (const strictThreshold of [0.93, 0.94, 0.95, 0.96]) {
    for (let t = 0.8; t <= 0.93 + 1e-9; t += 0.01) {
      const config = { ...policy.GAP_GROUPING, threshold: Number(t.toFixed(3)), strictThreshold };
      sweep.push({ threshold: config.threshold, strictThreshold, grouping: evaluateGrouping(policy, prepared, config, seeds) });
    }
  }
  // Lowest thresholds with zero false merges on every ordering; ties go to the
  // stricter "unknown aspect" threshold.
  const safe = sweep.filter((row) => row.grouping.minPrecision === 1)
    .sort((a, b) => b.grouping.meanRecall - a.grouping.meanRecall || b.strictThreshold - a.strictThreshold || b.threshold - a.threshold);
  const recommended = safe[0] ? { threshold: safe[0].threshold, strictThreshold: safe[0].strictThreshold } : null;
  const production = { threshold: policy.GAP_GROUPING.threshold, strictThreshold: policy.GAP_GROUPING.strictThreshold };
  const preparedHeldOut = heldOut?.length ? await prepare({ embed, policy, items: heldOut }) : [];
  const heldOutResult = preparedHeldOut.length ? evaluateGrouping(policy, preparedHeldOut, { ...policy.GAP_GROUPING, ...production }, seeds) : null;
  const combined = preparedHeldOut.length ? evaluateGrouping(policy, [...prepared, ...preparedHeldOut], { ...policy.GAP_GROUPING, ...production }, seeds) : null;
  const hardestNegative = pairs.filter((p) => !p.same && p.compatible).sort((a, b) => b.score - a.score).slice(0, 6);
  const aspectConflictsOnPositives = pairs.filter((p) => p.same && p.aspects === "conflict").map((p) => [p.a, p.b]);
  return { questions: prepared.length, heldOutQuestions: preparedHeldOut.length, sweep, recommended, production,
    calibrationAtProduction: evaluateGrouping(policy, prepared, { ...policy.GAP_GROUPING, ...production }, seeds),
    heldOutAtProduction: heldOutResult, combinedAtProduction: combined, hardestNegative, aspectConflictsOnPositives };
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.localModels) await useLocalModels(args.localModels);
  const { embedText } = require("../src/ai");
  const policy = await import(pathToFileURL(path.join(__dirname, "../supabase/functions/rafa-agent-api/knowledgeGapPolicy.mjs")).href);
  const report = await calibrate({ embed: embedText, policy });
  const fmt = (value) => value.toFixed(3);
  const line = (g) => `minP=${fmt(g.minPrecision)} meanP=${fmt(g.meanPrecision)} meanR=${fmt(g.meanRecall)} minR=${fmt(g.minRecall)} falseMerges<=${g.maxFalseMerges}`;
  for (const row of report.sweep) console.log(`t=${row.threshold.toFixed(2)} strict=${row.strictThreshold.toFixed(2)} ${line(row.grouping)}`);
  console.log(`hardest compatible negatives (raw cosine) ${JSON.stringify(report.hardestNegative.map((p) => [p.a, p.b, Number(p.score.toFixed(3)), p.aspects]))}`);
  console.log(`aspect conflicts on true paraphrases ${JSON.stringify(report.aspectConflictsOnPositives)}`);
  console.log(`recommended ${JSON.stringify(report.recommended)} production ${JSON.stringify(report.production)}`);
  console.log(`calibration @production ${line(report.calibrationAtProduction)}`);
  if (report.heldOutAtProduction) console.log(`held-out    @production ${line(report.heldOutAtProduction)}`);
  if (report.combinedAtProduction) console.log(`combined    @production ${line(report.combinedAtProduction)}`);
  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, "knowledge_gap_grouping_calibration.json"), JSON.stringify(report, null, 2), "utf8");
  }
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`calibration failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { calibrate, simulateGrouping, pairMetrics, seededOrder, evaluateGrouping, prepare };
