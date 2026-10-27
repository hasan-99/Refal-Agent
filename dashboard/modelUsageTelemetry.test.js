import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildModelUsageEvent } from "./modelUsageTelemetry.js";

const require = createRequire(import.meta.url);
const { redactAuditEventFields } = require("../src/sensitiveData.js");

test("dashboard forwards Edge provider latency into the redacted usage event", () => {
  const event = buildModelUsageEvent("dashboard", "operator@example.test", {
    model: "provider/model-a",
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
    costUsd: 0.0025,
    providerReported: true,
    providerLatencyMs: 842,
    rawResponse: { customerText: "private" }
  });
  const stored = {
    event: event.event,
    fields: redactAuditEventFields(event.fields)
  };
  assert.equal(stored.event, "ai_usage");
  assert.deepEqual(stored.fields, {
    source: "dashboard",
    userId: "[redacted]",
    model: "[redacted]",
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
    costUsd: 0.0025,
    providerLatencyMs: 842
  });
  assert.doesNotMatch(JSON.stringify(stored), /operator@example\.test|provider\/model-a|private/u);
});
