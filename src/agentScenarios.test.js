// REFAL-AGENT-015 — asserts every scenario in src/agentScenarios.js through
// the real Agent-runtime boundary. See that file for the scenario
// definitions, the shared runner, and the "scripted decision" caveat.

const test = require("node:test");
const assert = require("node:assert/strict");
const { SCENARIOS, runScenario } = require("./agentScenarios");

// Scenarios whose currently-observed behavior is a real, already-filed gap
// (REFAL-AGENT-022..026). These must still run — never silently skipped —
// but a scenario's expected (desired) outcome will currently genuinely fail,
// so CI asserts the FAILURE is the expected (known) one, not an unexpected
// regression. None exist in this matrix today (see agentScenarios.js's notes
// on F01/G06 explaining why those two scenarios actually PASS at this
// boundary despite 022/023 remaining open) — this map stays ready for when a
// future scenario does need it.
const KNOWN_FAILURES = {};

test("the scenario matrix has stable, unique IDs matching the ticket's A-H category scheme", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate scenario id found");
  for (const scenario of SCENARIOS) {
    assert.match(scenario.id, /^[A-H]\d{2}$/, scenario.id);
    assert.ok(scenario.description && scenario.description.length > 10, `${scenario.id}: missing description`);
    assert.ok(scenario.locale, `${scenario.id}: missing locale`);
    assert.equal(typeof scenario.run, "function", `${scenario.id}: missing run()`);
    assert.equal(typeof scenario.expected, "object", `${scenario.id}: missing expected`);
  }
});

for (const scenario of SCENARIOS) {
  test(`[${scenario.id}] ${scenario.description}`, async () => {
    const { failures, passed, observed } = await runScenario(scenario);
    const known = KNOWN_FAILURES[scenario.id];
    if (known) {
      // The gap is expected to still be open: assert it IS still failing
      // (so this test starts failing loudly the moment someone fixes it
      // without updating this map — never a silent, stale "known failure").
      assert.equal(passed, false, `[${scenario.id}] expected to still be a known failure (${known.ticket}) but it now PASSES — update agentScenarios.test.js's KNOWN_FAILURES map`);
      return;
    }
    assert.equal(passed, true, `[${scenario.id}] unexpected failure(s):\n${failures.join("\n")}\nouticome=${observed.result.outcome} toolsUsed=${JSON.stringify(observed.result.toolsUsed)}`);
  });
}
