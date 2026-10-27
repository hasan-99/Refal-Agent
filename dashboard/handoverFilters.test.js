import test from "node:test";
import assert from "node:assert/strict";
import { filterHandovers, normalizeHandoverLanguage } from "./handoverFilters.js";
import { groupHandoversByContact } from "./handoverGrouping.js";

const records = [
  { id: "1", department: "company_formation", priority: "high", status: "open", language: "english", createdAt: "2026-10-10T12:00:00Z" },
  { id: "2", department: "property", priority: "urgent", status: "acknowledged", language: "ar", createdAt: "2026-10-11T12:00:00Z" },
  { id: "3", department: "company_formation", priority: "normal", status: "open", language: "el", createdAt: "2026-10-12T12:00:00Z" },
  { id: "4", department: "property", priority: "normal", status: "open", language: "", createdAt: "not-a-date" }
];

test("handover queue filters by department, priority, status, language, and inclusive date bounds", () => {
  const result = filterHandovers(records, {
    department: "property", priority: "urgent", status: "acknowledged", language: "ar", from: "2026-10-11", to: "2026-10-11"
  });
  assert.deepEqual(result.map((item) => item.id), ["2"]);
});

test("combined filters exclude missing dates for a selected date range and unknown locale is explicit", () => {
  assert.deepEqual(filterHandovers(records, { from: "2026-10-10", to: "2026-10-12", language: "unknown" }).map((item) => item.id), []);
  assert.deepEqual(filterHandovers(records, { language: "unknown" }).map((item) => item.id), ["4"]);
});

test("language aliases normalize to the dashboard's three language codes", () => {
  assert.deepEqual(["English", "العربية", "Ελληνικά", "unsupported"].map(normalizeHandoverLanguage), ["en", "ar", "el", "unknown"]);
});

test("filters keep a contact group visible when its matching department, language, and date belong to an older request", () => {
  const grouped = groupHandoversByContact([
    { id: "latest", contact: { id: "contact-1" }, department: "accounting", language: "en", status: "open", priority: "normal", createdAt: "2026-10-12T10:00:00Z" },
    { id: "matching", contact: { id: "contact-1" }, department: "property", language: "ar", status: "acknowledged", priority: "high", createdAt: "2026-10-11T10:00:00Z" },
    { id: "oldest", contact: { id: "contact-1" }, department: "legal", language: "el", status: "open", priority: "normal", createdAt: "2026-10-10T10:00:00Z" }
  ]);

  const [visible] = filterHandovers(grouped, { department: "property", language: "ar", from: "2026-10-11", to: "2026-10-11" });
  assert.equal(visible.groupKey, "contact-1");
  assert.deepEqual(visible.matchedRecords.map((item) => item.id), ["matching"]);
  assert.deepEqual(visible.records.map((item) => item.id), ["latest", "matching", "oldest"]);
  assert.equal(visible.matchedRecords[0].id, "matching", "follow-up actions can target the request that satisfied the filters");
});

test("filters never combine department, language, and date values from different requests in one contact group", () => {
  const grouped = groupHandoversByContact([
    { id: "department", contact: { id: "contact-1" }, department: "property", language: "en", status: "open", createdAt: "2026-10-12T10:00:00Z" },
    { id: "language-date", contact: { id: "contact-1" }, department: "accounting", language: "ar", status: "open", createdAt: "2026-10-11T10:00:00Z" }
  ]);
  assert.deepEqual(filterHandovers(grouped, { department: "property", language: "ar", from: "2026-10-11", to: "2026-10-11" }), []);
});
