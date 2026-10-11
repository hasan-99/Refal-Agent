"use strict";

const { createMessageExecutor } = require("../src/messageConcurrency");

const LANGUAGES = ["en", "ar", "el"];
const STAGES = ["retrieval", "model", "provider", "database", "whatsapp"];
const MAX_SYNTHETIC_TURNS = 10000;

function integerOption(name, value, { min, max }) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function parseArgs(argv) {
  const out = { count: 30, concurrency: 6, queue: 100, failures: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [key, inline] = arg.split("=", 2);
    const value = inline ?? argv[++i];
    if (value === undefined || String(value).startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--count") out.count = integerOption(key, value, { min: 1, max: MAX_SYNTHETIC_TURNS });
    else if (key === "--concurrency") out.concurrency = integerOption(key, value, { min: 1, max: 32 });
    else if (key === "--queue") out.queue = integerOption(key, value, { min: 0, max: 2000 });
    else if (key === "--fail") out.failures = String(value).split(",").filter(Boolean);
    else throw new Error(`Unknown option: ${key}`);
  }
  return out;
}

async function runSyntheticAgentLoad(options = {}) {
  const count = options.count === undefined ? 30 : integerOption("count", options.count, { min: 1, max: MAX_SYNTHETIC_TURNS });
  const concurrency = options.concurrency === undefined ? 6 : integerOption("concurrency", options.concurrency, { min: 1, max: 32 });
  const queue = options.queue === undefined ? 100 : integerOption("queue", options.queue, { min: 0, max: 2000 });
  const executor = createMessageExecutor({ concurrency, maxQueue: queue });
  const failureStages = new Set(options.failures || []);
  for (const stage of failureStages) if (!STAGES.includes(stage)) throw new Error(`Unknown failure stage: ${stage}`);

  const turnTimes = [];
  const queueTimes = [];
  const languageOrder = [];
  const failedStages = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  const actionIds = new Set();
  let duplicateActionAttempts = 0;
  let simulatedActionEffects = 0;
  let peakConcurrency = 0;
  let activeTurns = 0;
  const consumedFailures = new Set();

  const turns = Array.from({ length: count }, (_, index) => {
    const contact = `synthetic-contact-${index % Math.max(1, Math.ceil(count / 3))}`;
    const language = LANGUAGES[index % LANGUAGES.length];
    const submittedAt = Date.now();
    return executor.run(contact, async () => {
      const startedAt = Date.now();
      queueTimes.push(startedAt - submittedAt);
      activeTurns += 1;
      peakConcurrency = Math.max(peakConcurrency, activeTurns);
      languageOrder.push({ index, contact, language });
      try {
        for (let stageIndex = 0; stageIndex < STAGES.length; stageIndex += 1) {
          const stage = STAGES[stageIndex];
          // Small deterministic delays emulate local stage work; no external systems are called.
          await new Promise((resolve) => setTimeout(resolve, 1 + ((index + stageIndex) % 3)));
          if (failureStages.has(stage) && !consumedFailures.has(stage)) {
            consumedFailures.add(stage);
            failedStages[stage] += 1;
            throw Object.assign(new Error(`Synthetic ${stage} failure`), { stage });
          }
        }
        const actionId = `synthetic-action-${Math.floor(index / 2)}`;
        if (actionIds.has(actionId)) duplicateActionAttempts += 1;
        else {
          actionIds.add(actionId);
          simulatedActionEffects += 1;
        }
        // A second local attempt deliberately exercises idempotency detection.
        if (index % 2 === 0) {
          if (actionIds.has(actionId)) duplicateActionAttempts += 1;
          else { actionIds.add(actionId); simulatedActionEffects += 1; }
        }
        return { index, contact, language, status: "synthetic-success" };
      } finally {
        activeTurns -= 1;
        turnTimes.push(Date.now() - submittedAt);
      }
    }).catch((error) => ({ index, contact, language, status: "synthetic-failure", failureStage: error.stage || "queue" }));
  });
  const results = await Promise.all(turns);
  const stats = executor.getStats();
  const output = {
    label: "SYNTHETIC / MOCKED LOAD ONLY",
    evidenceClass: "synthetic",
    productionMeasurements: false,
    disclaimer: "No provider, database, live retrieval, WhatsApp, or network calls were made. This is not a production-readiness claim.",
    configuration: { count, concurrency: stats.concurrency, queue: stats.maxQueue, injectedFailures: [...failureStages] },
    results: {
      completed: results.filter((r) => r.status === "synthetic-success").length,
      failed: results.filter((r) => r.status === "synthetic-failure").length,
      queueRejected: results.filter((r) => r.status === "synthetic-failure" && r.failureStage === "queue").length
    },
    metricsMs: { queueP50: percentile(queueTimes, 0.50), queueP95: percentile(queueTimes, 0.95), turnP50: percentile(turnTimes, 0.50), turnP95: percentile(turnTimes, 0.95) },
    peakConcurrency,
    languageOrder,
    failuresByStage: { ...failedStages, queue: results.filter((r) => r.status === "synthetic-failure" && r.failureStage === "queue").length },
    duplicateActionAttempts,
    simulatedActionEffects,
    finalExecutorStats: stats
  };
  return output;
}

if (require.main === module) {
  runSyntheticAgentLoad(parseArgs(process.argv.slice(2))).then((output) => {
    console.log(JSON.stringify(output, null, 2));
  }, (error) => {
    console.error(`SYNTHETIC / MOCKED LOAD ONLY: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runSyntheticAgentLoad, parseArgs, percentile, LANGUAGES, STAGES, MAX_SYNTHETIC_TURNS };
