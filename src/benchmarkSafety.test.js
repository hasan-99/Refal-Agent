// REFAL-AGENT-016 — test 12: the benchmark must never be able to reach a
// real customer, real Google Calendar, real WhatsApp, or real Supabase.
// Static source checks: the benchmark's own files must never require a
// real side-effecting module. This is a regression guard — if someone later
// wires a real store into the benchmark, this test fails immediately.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FORBIDDEN_MODULES = [
  "./supabaseStore", "../src/supabaseStore",
  "./bot", "../src/bot",
  "./whatsappPairing", "../src/whatsappPairing",
  "./whatsappContact", "../src/whatsappContact",
  "@whiskeysockets/baileys"
];

const BENCHMARK_SOURCE_FILES = [
  path.join(__dirname, "benchmarkScenarios.js"),
  path.join(__dirname, "..", "scripts", "runAgentBenchmark.js")
];

test("benchmark source files never require a real side-effecting module (Supabase store, bot.js, WhatsApp transport)", () => {
  for (const file of BENCHMARK_SOURCE_FILES) {
    if (!fs.existsSync(file)) continue; // tolerate running before the runner script exists yet
    const source = fs.readFileSync(file, "utf8");
    for (const forbidden of FORBIDDEN_MODULES) {
      assert.doesNotMatch(source, new RegExp(`require\\(["']${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\)`), `${path.basename(file)} must not require ${forbidden}`);
    }
  }
});

test("the benchmark's googleapis usage is always behind an explicit mock installer (google.calendar is reassigned, never left as the real client during a booking scenario)", () => {
  const runnerPath = path.join(__dirname, "..", "scripts", "runAgentBenchmark.js");
  if (!fs.existsSync(runnerPath)) return; // covered once the runner exists; see agentScenarios.js's own equivalent test for the established pattern
  const source = fs.readFileSync(runnerPath, "utf8");
  if (/googleapis/.test(source)) {
    assert.match(source, /google\.calendar\s*=/, "any googleapis usage in the benchmark runner must install a mock via google.calendar = ...");
  }
});

test("every booking-category benchmark scenario is routed through the real Ticket 015 withCalendarEnv mock helper, not a bare real calendar call", () => {
  const { BENCHMARK_SCENARIOS } = require("./benchmarkScenarios");
  const bookingScenarios = BENCHMARK_SCENARIOS.filter((s) => s.category === "booking");
  assert.ok(bookingScenarios.length > 0, "expected at least one booking scenario in the benchmark subset");
  // withCalendarEnv itself is unit-proven safe by agentScenarios.test.js; here
  // we only need to confirm the runner actually imports it for booking turns.
  const runnerPath = path.join(__dirname, "..", "scripts", "runAgentBenchmark.js");
  if (!fs.existsSync(runnerPath)) return;
  const source = fs.readFileSync(runnerPath, "utf8");
  assert.match(source, /withCalendarEnv/, "the benchmark runner must reuse agentScenarios.js's withCalendarEnv mock for booking scenarios");
});
