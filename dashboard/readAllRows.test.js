import test from "node:test";
import assert from "node:assert/strict";
import { readAllRows, withStableCreatedAtIdOrder, withStableIdOrder } from "./readAllRows.js";

test("readAllRows pages through the complete record set instead of accepting the first-page cap", async () => {
  const ranges = [];
  const rows = await readAllRows(async (_path, range) => {
    ranges.push(range);
    const start = Number(range.split("-")[0]);
    return Array.from({ length: Math.min(2, Math.max(0, 5 - start)) }, (_value, index) => start + index);
  }, "records", 2);
  assert.deepEqual(rows, [0, 1, 2, 3, 4]);
  assert.deepEqual(ranges, ["0-1", "2-3", "4-5"]);
});

test("readAllRows does not return a partial result after a later page fails", async () => {
  await assert.rejects(readAllRows(async (_path, range) => {
    if (range === "2-3") throw new Error("page unavailable");
    return [1, 2];
  }, "records", 2), /page unavailable/);
});

test("handover ledger queries use a unique ID tie-breaker after creation time", () => {
  assert.equal(
    withStableCreatedAtIdOrder("rafa_handovers?select=id&order=created_at.desc&status=eq.open"),
    "rafa_handovers?select=id&status=eq.open&order=created_at.desc,id.desc"
  );
  assert.equal(withStableCreatedAtIdOrder("rafa_notification_jobs?select=id", "asc"), "rafa_notification_jobs?select=id&order=created_at.asc,id.asc");
  assert.throws(() => withStableCreatedAtIdOrder("records", "sideways"), /Order direction/);
});

test("tied creation timestamps cross offset page boundaries once when ID is the secondary order", async () => {
  const all = [
    { id: "d", created_at: "2026-10-11T10:00:00Z" },
    { id: "c", created_at: "2026-10-11T10:00:00Z" },
    { id: "b", created_at: "2026-10-11T10:00:00Z" },
    { id: "a", created_at: "2026-10-11T10:00:00Z" },
    { id: "z", created_at: "2026-10-10T10:00:00Z" }
  ];
  const ordered = all.toSorted((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  const ranges = [];
  const rows = await readAllRows(async (_path, range) => {
    ranges.push(range);
    const [start, end] = range.split("-").map(Number);
    return ordered.slice(start, end + 1);
  }, "records", 2);
  assert.deepEqual(rows.map((row) => row.id), ["d", "c", "b", "a", "z"]);
  assert.deepEqual(new Set(rows.map((row) => row.id)).size, 5);
  assert.deepEqual(ranges, ["0-1", "2-3", "4-5"]);
});

test("knowledge revision pagination uses a unique ID tie-breaker for its chosen sort column", () => {
  assert.equal(withStableIdOrder("rafa_knowledge_documents?select=id&order=fetched_at.desc&review_status=eq.pending", "fetched_at"),
    "rafa_knowledge_documents?select=id&review_status=eq.pending&order=fetched_at.desc,id.desc");
  assert.throws(() => withStableIdOrder("records", "created_at;select=*"), /safe order column/u);
});
