const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { classify, checkImportMode, summarizeActions, renderRollback, rollbackStateQuery, canonicalUrlFor } = require("./ragPackageImport");

const MODEL = "e5@pinned";
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const chunk = (id, hash) => ({ chunkId: id, canonicalUrl: canonicalUrlFor(id), contentHash: hash });
const live = (id, hash, extra = {}) => ({ canonical_url: canonicalUrlFor(id), enabled: true, approved: true, approved_sha: hash,
  approved_importer: "rag-package", chunks: 1, embedded: 1, embedding_model: MODEL, ...extra });

// 3 live chunks; the file carries one changed chunk and one new chunk only.
const db = [live("RF-KB-001", "h1"), live("RF-KB-002", "h2"), live("RF-KB-003", "h3")];
const plan = { chunks: [chunk("RF-KB-001", "h1-new"), chunk("RF-KB-041", "h41")], inactive: [] };

test("a partial import never deactivates live chunks that are missing from the file", () => {
  const actions = classify(plan, db, { embeddingModel: MODEL, mode: "partial" });
  const byId = Object.fromEntries(actions.map((a) => [a.chunkId, a.action]));
  assert.deepEqual(byId, { "RF-KB-001": "update", "RF-KB-041": "insert", "RF-KB-002": "kept", "RF-KB-003": "kept" });
});

test("partial is the default when no mode is passed to the planner", () => {
  const actions = classify(plan, db, { embeddingModel: MODEL });
  assert.equal(actions.filter((a) => a.action === "deactivate").length, 0);
});

test("partial mode still honours explicit retirements and inactive rows", () => {
  const actions = classify({ ...plan, inactive: ["RF-KB-003"] }, db, { embeddingModel: MODEL, mode: "partial", retired: ["RF-KB-002"] });
  const byId = Object.fromEntries(actions.map((a) => [a.chunkId, a.action]));
  assert.equal(byId["RF-KB-002"], "deactivate");
  assert.equal(byId["RF-KB-003"], "deactivate");
});

test("full mode deactivates live chunks missing from the file", () => {
  const actions = classify(plan, db, { embeddingModel: MODEL, mode: "full" });
  assert.deepEqual(actions.filter((a) => a.action === "deactivate").map((a) => a.chunkId).sort(), ["RF-KB-002", "RF-KB-003"]);
});

test("an unknown mode is rejected by the planner", () => {
  assert.throws(() => classify(plan, db, { embeddingModel: MODEL, mode: "everything" }), /unknown import mode/u);
});

test("the script cannot run without an explicit mode", () => {
  const check = checkImportMode(null, {}, 2);
  assert.equal(check.ok, false);
  assert.match(check.errors[0], /cannot tell whether this file is the full package/u);
});

test("full mode needs the manifest to agree, with a matching line count", () => {
  assert.equal(checkImportMode("partial", {}, 2).ok, true);
  assert.equal(checkImportMode("full", {}, 66).ok, false);
  assert.equal(checkImportMode("full", { packageMode: "full" }, 66).ok, false);
  assert.match(checkImportMode("full", { packageMode: "full", chunkCount: 61 }, 13).errors[0], /does not match the 13 lines/u);
  assert.equal(checkImportMode("full", { packageMode: "full", chunkCount: 66 }, 66).ok, true);
  assert.equal(checkImportMode("upsert", {}, 1).ok, false);
});

test("the pre-write summary counts every outcome", () => {
  const actions = classify(plan, db, { embeddingModel: MODEL, mode: "full" });
  assert.deepEqual(summarizeActions(actions, db), { added: 1, updated: 1, superseded: 1, reembedded: 0, unchanged: 0, deactivated: 2, kept: 0, skippedOperatorEdited: 0 });
  const partial = classify(plan, db, { embeddingModel: MODEL, mode: "partial" });
  assert.equal(summarizeActions(partial, db).kept, 2);
  assert.equal(summarizeActions(partial, db).deactivated, 0);
});

test("rollback restores flags, disables inserts and rebuilds the previous text only when its hash matches", () => {
  const prevTitle = "Old title";
  const prevContent = "old approved text";
  const prevHash = sha(`RF-KB-001 — ${prevTitle}\n${prevContent}`);
  const actions = [
    { chunkId: "RF-KB-001", canonicalUrl: canonicalUrlFor("RF-KB-001"), action: "update" },
    { chunkId: "RF-KB-041", canonicalUrl: canonicalUrlFor("RF-KB-041"), action: "insert" },
    { chunkId: "RF-KB-002", canonicalUrl: canonicalUrlFor("RF-KB-002"), action: "deactivate" },
    { chunkId: "RF-KB-003", canonicalUrl: canonicalUrlFor("RF-KB-003"), action: "update" }
  ];
  const before = [
    { canonical_url: canonicalUrlFor("RF-KB-001"), enabled: true, approved: true, title: prevTitle, canonical_content: prevContent, content_sha256: prevHash,
      language_code: "ar", metadata: { agentId: "refal", knowledgeScope: "s", category: "c", sourceFile: "f", sourceFamily: "RF-KB", packageVersion: "1.0", reviewedAt: "2026-10-26", keywords: ["k"] } },
    { canonical_url: canonicalUrlFor("RF-KB-002"), enabled: true, approved: true, last_status: null },
    { canonical_url: canonicalUrlFor("RF-KB-003"), enabled: true, approved: true, title: "t", canonical_content: "c", content_sha256: "not-the-hash", metadata: {} }
  ];
  const { flagsSql, packageRows, problems } = renderRollback(actions, before, { agentId: "refal" });
  assert.match(flagsSql, /set enabled = true, approved = true, last_status = null, updated_at = now\(\) where canonical_url = \$kb\$manual:refal-rag-package:RF-KB-002\$kb\$/u);
  assert.match(flagsSql, /set enabled = false, approved = false, last_status = 'disabled'.*RF-KB-041/u);
  assert.equal(packageRows.length, 1);
  assert.equal(packageRows[0].content_hash, prevHash);
  assert.equal(sha(packageRows[0].embedding_text), packageRows[0].content_hash);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /RF-KB-003/u);
});

test("the rollback state query only reads the touched sources", () => {
  const sql = rollbackStateQuery([canonicalUrlFor("RF-KB-001")]);
  assert.match(sql, /^select /u);
  assert.doesNotMatch(sql, /\b(update|insert|delete)\b/iu);
  assert.match(sql, /RF-KB-001/u);
});
