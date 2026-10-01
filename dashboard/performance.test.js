import test from "node:test";
import assert from "node:assert/strict";
import { aggregateModelUsage, aggregatePerformance, leadTemperatureStatus, normalizeQualificationStatus, qualificationStatus, workflowSignalStatus } from "./performance.js";

test("qualification accepts only explicitly supported manual statuses", () => {
  assert.equal(normalizeQualificationStatus("qualified"), "qualified");
  assert.equal(normalizeQualificationStatus("not_qualified"), "not_qualified");
  assert.equal(normalizeQualificationStatus("hot"), "unreviewed");
  assert.equal(qualificationStatus({ profile: { qualification: { score: 99 } } }), "unreviewed");
});

test("lead temperature totals reflect automatic conversation status", () => {
  assert.equal(leadTemperatureStatus({ leadTemperatureStatus: "hot" }), "hot");
  const metrics = aggregatePerformance({ leads: [
    { leadTemperatureStatus: "hot" },
    { leadTemperatureStatus: "warm" },
    { leadTemperatureStatus: "cold" },
    {}
  ] });
  assert.deepEqual(metrics.leads.temperature, { hot: 1, warm: 1, cold: 1, unclassified: 1 });
});

test("workflow aggregation counts operator attention signals", () => {
  assert.deepEqual(workflowSignalStatus({ workflow: { intent: "complaint", priority: "urgent", consent: { followUp: "denied" }, handover: { required: true }, flags: { complaint: true } } }), {
    intent: "complaint", classification: "unclassified", priority: "urgent", dimensionTotal: 0, consent: "denied", followUp: "consent_required", complaint: true, existingClient: false, handoverRequired: true
  });
  const metrics = aggregatePerformance({ leads: [
    { workflow: { priority: "high", handover: { required: true }, flags: { complaint: true }, consent: { followUp: "granted" } } },
    { workflow: { flags: { existingClient: true }, consent: { followUp: "unknown" } } }
  ] });
  assert.deepEqual(metrics.leads.workflow, { priority: 1, complaints: 1, existingClients: 1, handovers: 1, consentGranted: 1, consentUnknown: 1 });
});

test("performance aggregates factual activity, manual qualification, and upcoming bookings", () => {
  const metrics = aggregatePerformance({
    now: new Date("2026-09-30T12:00:00Z"),
    overview: { stats: { conversationsToday: 5, conversationsThisWeek: 9, conversationsThisMonth: 14, messagesToday: 8 } },
    leads: [
      { id: "a", conversationCount: 4, profile: { qualification: { status: "qualified" } } },
      { id: "b", conversationCount: 1, profile: { qualification: { status: "not_qualified" } } },
      { id: "c", conversationCount: 0 }
    ],
    bookings: [
      { id: "future", userId: "a", status: "confirmed", start: "2026-10-02T10:00:00Z" },
      { id: "past", userId: "b", status: "booked", start: "2026-09-20T10:00:00Z" },
      { id: "pending", userId: "c", status: "pending_calendar", start: "2026-10-03T10:00:00Z" }
    ]
  });

  assert.deepEqual(metrics.conversations, { today: 5, week: 9, month: 14, messagesToday: 8, engagedContacts: 2 });
  assert.deepEqual(metrics.leads, { total: 3, qualified: 1, notQualified: 1, unreviewed: 1, reviewed: 2, booked: 2, temperature: { hot: 0, warm: 0, cold: 0, unclassified: 3 }, workflow: { priority: 0, complaints: 0, existingClients: 0, handovers: 0, consentGranted: 0, consentUnknown: 3 } });
  assert.equal(metrics.appointments.booked, 2);
  assert.equal(metrics.appointments.upcoming, 1);
  assert.equal(metrics.appointments.upcomingList[0].id, "future");
});

test("performance aggregation safely handles absent and malformed payloads", () => {
  assert.deepEqual(aggregatePerformance(), {
    conversations: { today: 0, week: 0, month: 0, messagesToday: 0, engagedContacts: 0 },
    leads: { total: 0, qualified: 0, notQualified: 0, unreviewed: 0, reviewed: 0, booked: 0, temperature: { hot: 0, warm: 0, cold: 0, unclassified: 0 }, workflow: { priority: 0, complaints: 0, existingClients: 0, handovers: 0, consentGranted: 0, consentUnknown: 0 } },
    appointments: { booked: 0, upcoming: 0, upcomingList: [] }
  });
});

test("usage aggregation keeps exact reported spend separate and never invents missing usage", () => {
  const report = aggregateModelUsage([
    { event: "ai_usage", source: "whatsapp", userId: "wa-1", model: "provider/model-a", at: "2026-09-30T10:00:00.000Z", promptTokens: 90, completionTokens: 10, totalTokens: 100, costUsd: 0.0012 },
    { event: "ai_usage_missing", source: "whatsapp", userId: "wa-1", model: "provider/model-a", at: "2026-09-30T11:00:00.000Z", promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null },
    { event: "ai_usage", source: "dashboard", userId: "admin-id", model: "provider/model-b", at: "2026-09-29T11:00:00.000Z", promptTokens: 40, completionTokens: 10, totalTokens: 50, costUsd: 0.0005 }
  ], [{ id: "wa-1", history: [{}, {}, {}] }], {
    now: new Date("2026-09-30T12:00:00.000Z"),
    clientLabel: (id, source) => source === "dashboard" ? "Dashboard chat" : "Lead A1B2C3"
  }).actual;

  assert.equal(report.interactions, 3);
  assert.equal(report.actualTokens, 150);
  assert.equal(report.exactCostUsd, 0.0017);
  assert.equal(report.missingCostInteractions, 1);
  assert.equal(report.byDay.find((day) => day.period === "2026-09-30").interactions, 2);
  assert.equal(report.byDay.length, 366);
  assert.equal(report.byMonth.find((month) => month.period === "2026-09").exactCostUsd, 0.0017);
  assert.equal(report.clients.length, 1);
  assert.equal(report.clients[0].clientLabel, "Lead A1B2C3");
  assert.equal(report.clients[0].missingCostInteractions, 1);
  assert.equal(report.interactionsList[0].totalTokens, null);
  assert.equal(report.interactionsList[0].costUsd, null);
  assert.equal(report.interactionsList[0].clientLabel, "Lead A1B2C3");
  assert.equal(report.heaviestClient.clientLabel, "Lead A1B2C3");
  assert.equal(report.longestContacts[0].turns, 3);
  assert.equal(JSON.stringify(report).includes('"userId":"wa-1"'), false);
});
