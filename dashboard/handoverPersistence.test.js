import test from "node:test";
import assert from "node:assert/strict";
import { mergeActiveHandover, sanitizeHandoverSummary } from "../supabase/functions/rafa-agent-api/handoverPersistence.mjs";

test("repeated handover confirmation updates one active record and preserves prior request history", () => {
  const existing = {
    id: "active-handover",
    contact_id: "contact-1",
    department: "investment",
    priority: "high",
    status: "open",
    source_turn_id: "turn-1",
    created_at: "2026-10-02T11:00:00Z",
    summary: { intent: "investment", need: "investment project" }
  };
  const merged = mergeActiveHandover(existing, {
    department: "general",
    priority: "normal",
    status: "open",
    summary: { intent: "general", opportunity: "investment" }
  }, { sourceTurnId: "turn-2", now: "2026-10-02T12:00:00Z" });

  assert.equal(merged.department, "investment");
  assert.equal(merged.priority, "high");
  assert.equal(merged.summary.intent, "investment");
  assert.deepEqual(merged.summary.relatedRequests.map((item) => item.sourceTurnId), ["turn-1", "turn-2"]);
  assert.equal(merged.source_turn_id, "turn-2");
});

test("retrying the same source turn does not duplicate its history entry", () => {
  const existing = {
    id: "active-handover", department: "investment", priority: "high", status: "open",
    source_turn_id: "turn-1", created_at: "2026-10-02T11:00:00Z",
    summary: { intent: "investment", relatedRequests: [{ sourceTurnId: "turn-2", department: "investment", priority: "high" }] }
  };
  const merged = mergeActiveHandover(existing, { department: "investment", priority: "high", status: "open", summary: { intent: "investment" } }, { sourceTurnId: "turn-2" });
  assert.equal(merged.summary.relatedRequests.filter((item) => item.sourceTurnId === "turn-2").length, 1);
});

test("handover persistence rejects greeting questions as names and safely renders structured requirements", () => {
  const summary = sanitizeHandoverSummary({
    customer: { name: "مرحبا، شو خدماتكم" },
    requirements: { investment: { country: "Cyprus", sector: "Technology" } }
  });

  assert.equal(summary.customer.name, null);
  assert.equal(summary.requirements, "investment.country: Cyprus; investment.sector: Technology");
});

test("handover persistence repairs malformed legacy name and object string values during merge", () => {
  const merged = mergeActiveHandover({
    department: "investment", priority: "high", status: "open", source_turn_id: "old-turn",
    summary: { customer: { name: "مرحبا، شو خدماتكم" }, requirements: "[object Object]" }
  }, {
    department: "investment", priority: "high", status: "open",
    summary: { intent: "investment", customer: { name: "Rami Haddad" }, requirements: "project exploration" }
  }, { sourceTurnId: "new-turn" });

  assert.equal(merged.summary.customer.name, "Rami Haddad");
  assert.equal(merged.summary.requirements, "project exploration");
  assert.doesNotMatch(JSON.stringify(merged.summary), /مرحبا، شو خدماتكم|\[object Object\]/);
});
