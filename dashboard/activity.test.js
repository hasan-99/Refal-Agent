import test from "node:test";
import assert from "node:assert/strict";
import { contactActivityStats, operatorSignals, recentConversations } from "./activity.js";

test("recent conversations use the latest non-empty customer messages", () => {
  const result = recentConversations([
    {
      id: "one",
      profile: { name: "Maya" },
      history: [
        { message: "Older question", at: "2026-09-28T10:00:00Z" },
        { message: "  Latest   question  ", at: "2026-09-30T10:00:00Z" },
        { message: "", response: "Assistant-only text", at: "2026-09-30T11:00:00Z" }
      ]
    },
    { id: "two", history: [{ message: "Another contact", at: "2026-09-29T10:00:00Z" }] }
  ]);

  assert.deepEqual(result.map(({ name, preview }) => ({ name, preview })), [
    { name: "Maya", preview: "Latest question" },
    { name: "WhatsApp contact", preview: "Another contact" },
    { name: "Maya", preview: "Older question" }
  ]);
});

test("recent conversations omit undated messages and respect the requested limit", () => {
  const result = recentConversations([{
    id: "one",
    history: [
      { message: "No timestamp" },
      { message: "First", at: "2026-09-29T10:00:00Z" },
      { message: "Second", at: "2026-09-30T10:00:00Z" }
    ]
  }], 1);

  assert.equal(result.length, 1);
  assert.equal(result[0].preview, "Second");
});

test("contact activity counts persisted turns and distinct active contacts", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const stats = contactActivityStats([
    { history: [{ at: "2026-09-29T12:00:00Z" }, { at: "2026-09-20T12:00:00Z" }] },
    { history: [{ at: "2026-09-01T12:00:00Z" }] },
    { history: [] }
  ], now);

  assert.deepEqual(stats, {
    contacts: 3,
    contactsWithConversations: 2,
    activeLast7Days: 1,
    conversationTurns: 3
  });
});

test("operator signals normalize workflow metadata without exposing raw credentials", () => {
  const signals = operatorSignals({
    id: "wa-1",
    profile: {
      intent: { primary: "existing-client", intents: ["existing-client", "complaint"] },
      classification: { label: "sensitive", department: "existing_client" },
      qualification: { dimensions: { need: 8, value: 3, timing: "soon", readiness: 4 } },
      consent: { followUp: "granted" },
      handover: { required: true, priority: "high", summary: "Call client; token=secret-value", nextAction: "Verify account" },
      existingClient: true
    }
  });

  assert.equal(signals.intent, "existing_client");
  assert.deepEqual(signals.intents, ["existing_client", "complaint"]);
  assert.deepEqual(signals.dimensions, { need: 5, value: 3, timing: null, authority: null, readiness: 4, fit: null });
  assert.equal(signals.consent.followUp, "granted");
  assert.equal(signals.flags.existingClient, true);
  assert.match(signals.handover.summary, /\[redacted\]/);
  assert.doesNotMatch(signals.handover.summary, /secret-value/);
});
