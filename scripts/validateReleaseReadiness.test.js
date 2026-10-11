"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_GATES, validateReleaseReadiness } = require("./validateReleaseReadiness");

function completePacket() {
  return {
    releaseOwner: "Release owner",
    gates: REQUIRED_GATES.map((id) => ({
      id,
      status: "pass",
      evidence: `evidence/${id}.txt`,
      verifiedBy: "Independent reviewer",
      verifiedAt: "2026-10-10T10:00:00Z"
    }))
  };
}

test("release readiness accepts only a complete evidence-backed gate packet", () => {
  assert.deepEqual(validateReleaseReadiness(completePacket(), new Date("2026-10-11T10:00:00Z")).errors, []);
  assert.equal(validateReleaseReadiness(completePacket(), new Date("2026-10-11T10:00:00Z")).ready, true);
});

test("missing, blocked, stale-format, or unowned gates fail closed", () => {
  const packet = completePacket();
  packet.releaseOwner = " ";
  packet.gates = packet.gates.filter((gate) => gate.id !== "crm_persistence_smoke");
  packet.gates.find((gate) => gate.id === "read_only_faq_rag_smoke").status = "blocked";
  packet.gates.find((gate) => gate.id === "handover_smoke").verifiedAt = "yesterday";
  const result = validateReleaseReadiness(packet, new Date("2026-10-11T10:00:00Z"));
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.includes("releaseOwner")));
  assert.ok(result.errors.some((error) => error.includes("crm_persistence_smoke: evidence missing")));
  assert.ok(result.errors.some((error) => error.includes("read_only_faq_rag_smoke: status must be pass")));
  assert.ok(result.errors.some((error) => error.includes("handover_smoke: valid past UTC verifiedAt")));
});

test("release owner cannot independently verify their own gates or future-dated evidence", () => {
  const packet = completePacket();
  packet.releaseOwner = "Hasan Omar";
  packet.gates[0].verifiedBy = "O. Hasan";
  packet.gates[1].verifiedAt = "2026-02-31T10:00:00Z";
  const result = validateReleaseReadiness(packet, new Date("2026-10-11T10:00:00Z"));
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.includes("prior_phase_gates: verifier must be independent")));
  assert.ok(result.errors.some((error) => error.includes("required_fix_regressions: valid past UTC verifiedAt")));
});

test("future verification timestamps are rejected", () => {
  const packet = completePacket();
  packet.gates[0].verifiedAt = "2026-10-12T10:00:00Z";
  const result = validateReleaseReadiness(packet, new Date("2026-10-11T10:00:00Z"));
  assert.ok(result.errors.some((error) => error.includes("prior_phase_gates: valid past UTC verifiedAt")));
});

test("invalid validation clock fails closed instead of accepting future evidence", () => {
  const packet = completePacket();
  packet.gates[0].verifiedAt = "2099-01-01T00:00:00Z";
  const result = validateReleaseReadiness(packet, new Date("invalid"));
  assert.equal(result.ready, false);
  assert.ok(result.errors.includes("validation clock must be a valid Date"));
});

test("duplicate and unknown gate ids are reported", () => {
  const packet = completePacket();
  packet.gates.push({ ...packet.gates[0] });
  packet.gates.push({ ...packet.gates[0], id: "activate_live" });
  const result = validateReleaseReadiness(packet, new Date("2026-10-11T10:00:00Z"));
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.includes("unique string id")));
  assert.ok(result.errors.some((error) => error.includes("activate_live: unknown gate")));
});

test("non-object or absent evidence packets are rejected", () => {
  assert.equal(validateReleaseReadiness(null, new Date("2026-10-11T10:00:00Z")).ready, false);
  assert.equal(validateReleaseReadiness([], new Date("2026-10-11T10:00:00Z")).ready, false);
});
