"use strict";

// Grouping with the REAL local multilingual-e5-small when it loads offline
// (RAFA_LOCAL_MODEL_PATH or C:/Temp/refal-models), otherwise with
// deterministic stub vectors. The mode used is printed as a test diagnostic.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const QUESTIONS = Object.freeze({
  address: "Can I change my company address?",
  addressAr: "هل أقدر أغير عنوان الشركة؟",
  registered: "Can registered office be changed later?",
  name: "Can I change my company name later?",
  office: "What is your office address?",
  cost: "كم تكلفة تسجيل الشركة؟",
  duration: "كم يستغرق تسجيل الشركة؟"
});

// Stub geometry mimics what e5 does on these pairs: the keyword-sharing
// negatives are MORE similar than the true cross-language paraphrase.
function stubVectors() {
  const base = Array.from({ length: 384 }, (_v, i) => Math.sin(i * 0.05));
  const nudge = (seed, amount) => base.map((value, i) => value + amount * Math.sin(i * 1.7 + seed));
  return { address: nudge(1, 0.3), addressAr: nudge(2, 0.35), registered: nudge(3, 0.4), name: nudge(1, 0.32), office: nudge(4, 0.3), cost: nudge(5, 0.2), duration: nudge(5, 0.22) };
}

async function loadEmbeddings() {
  const modelPath = process.env.RAFA_LOCAL_MODEL_PATH || "C:/Temp/refal-models";
  if (!fs.existsSync(path.join(modelPath, "Xenova", "multilingual-e5-small"))) return { mode: "stub", vectors: stubVectors() };
  try {
    const { env } = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href.replace(/transformers\.node\.cjs$/u, "transformers.node.mjs"));
    env.allowRemoteModels = false;
    env.localModelPath = modelPath;
    const { embedText } = require("./ai");
    const vectors = {};
    for (const [key, text] of Object.entries(QUESTIONS)) vectors[key] = await embedText(text);
    return { mode: "real-e5", vectors };
  } catch {
    return { mode: "stub", vectors: stubVectors() };
  }
}

function simulate(policy, vectors, keys) {
  const groups = [];
  const assignment = {};
  for (const key of keys) {
    const vector = policy.toUnitVector(vectors[key]);
    const candidates = groups.map((group) => ({ id: group.id, similarity: policy.cosine(group.centroid, vector), category: "corporate",
      reason: "missing_knowledge", facets: group.facets, objects: group.objects }));
    const decision = policy.decideGapGroup({ category: "corporate", reason: "missing_knowledge", question: QUESTIONS[key] }, candidates);
    if (decision.groupId === null) {
      const aspects = policy.questionAspects(QUESTIONS[key]);
      groups.push({ id: `g${groups.length}`, centroid: vector, count: 1, facets: aspects.facets, objects: aspects.objects });
      assignment[key] = groups.at(-1).id;
    } else {
      const group = groups.find((item) => item.id === decision.groupId);
      group.centroid = policy.updateCentroid(group.centroid, group.count, vector);
      group.count += 1;
      assignment[key] = group.id;
    }
  }
  return assignment;
}

test("multilingual paraphrases group; keyword-sharing questions that need different knowledge do not", async (t) => {
  const policy = await import(pathToFileURL(path.join(__dirname, "../supabase/functions/rafa-agent-api/knowledgeGapPolicy.mjs")).href);
  const { mode, vectors } = await loadEmbeddings();
  t.diagnostic(`embedding mode: ${mode}`);
  const assignment = simulate(policy, vectors, ["address", "addressAr", "registered", "name", "office", "cost", "duration"]);
  if (mode === "real-e5") {
    assert.equal(assignment.addressAr, assignment.address, "Arabic paraphrase joins the English group");
    assert.equal(assignment.registered, assignment.address, "'registered office' paraphrase joins the same group");
  }
  assert.notEqual(assignment.name, assignment.address, "company name change is a different gap");
  assert.notEqual(assignment.office, assignment.address, "REFAL's own office address is a different gap");
  assert.notEqual(assignment.cost, assignment.duration, "registration cost and registration time stay apart");
  assert.notEqual(assignment.cost, assignment.address);
});

test("duplicates of the same question always group", async () => {
  const policy = await import(pathToFileURL(path.join(__dirname, "../supabase/functions/rafa-agent-api/knowledgeGapPolicy.mjs")).href);
  const vector = policy.toUnitVector(stubVectors().address);
  const decision = policy.decideGapGroup({ category: "corporate", reason: "missing_knowledge", question: "can i change my company address" },
    [{ id: "g1", similarity: policy.cosine(vector, vector), category: "corporate", reason: "missing_knowledge", facets: ["change"], objects: ["company_address"] }]);
  assert.equal(decision.groupId, "g1");
});
