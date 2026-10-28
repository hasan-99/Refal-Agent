import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_FILTERS, activeFilterCount, buildListQuery, initials, mergePage, percent, relativeTime, sparklinePath } from "./knowledgeGapsView.js";

test("list query drops 'all' filters, keeps status and always pages", () => {
  const query = new URLSearchParams(buildListQuery({ ...EMPTY_FILTERS, q: " refund ", language: "ar" }, { offset: 40 }));
  assert.equal(query.get("q"), "refund");
  assert.equal(query.get("status"), "active");
  assert.equal(query.get("language"), "ar");
  assert.equal(query.has("priority"), false);
  assert.equal(query.get("limit"), "20");
  assert.equal(query.get("offset"), "40");
  assert.equal(new URLSearchParams(buildListQuery({ status: "all" })).get("status"), "all");
});

test("only the panel filters count toward the Filters badge", () => {
  assert.equal(activeFilterCount(EMPTY_FILTERS), 0);
  assert.equal(activeFilterCount({ ...EMPTY_FILTERS, q: "x", status: "done", priority: "high", category: "pricing" }), 2);
});

test("pages merge without duplicates when a gap moves while scrolling", () => {
  assert.deepEqual(mergePage([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }, null]).map((item) => item.id), ["a", "b", "c"]);
});

test("relative time, initials and percent are readable and safe on bad input", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.equal(relativeTime("2026-10-28T11:59:40Z", now), "just now");
  assert.equal(relativeTime("2026-10-28T09:00:00Z", now), "3 hours ago");
  assert.equal(relativeTime("2026-10-27T12:00:00Z", now), "yesterday");
  assert.equal(relativeTime("not a date", now), "—");
  assert.equal(initials("hasan.jahouse@refalco.com"), "HJ");
  assert.equal(initials("admin@refalco.com"), "AD");
  assert.equal(initials(""), "?");
  assert.equal(percent(0.456), "46%");
  assert.equal(percent(undefined), "—");
});

test("sparkline path spans the box and handles empty and flat data", () => {
  assert.deepEqual(sparklinePath([]), { line: "", area: "" });
  const flat = sparklinePath([{ count: 0 }, { count: 0 }]);
  assert.match(flat.line, /^M0 30 L100 30$/u);
  const path = sparklinePath([{ count: 1 }, { count: 4 }, { count: 2 }]);
  assert.match(path.line, /^M0 [\d.]+ L50 4 L100 [\d.]+$/u);
  assert.ok(path.area.endsWith("L100 32 L0 32 Z"));
});
