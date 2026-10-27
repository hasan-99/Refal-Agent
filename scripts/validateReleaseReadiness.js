"use strict";

// P14.5/P14.6 evidence packet validator. This validates supplied release
// evidence; it does not inspect production state or authorize activation.
const REQUIRED_GATES = Object.freeze([
  "prior_phase_gates",
  "required_fix_regressions",
  "security_and_leak_checks",
  "calendar_disabled_or_verified",
  "existing_client_data_fail_closed",
  "handover_and_complaint_routes",
  "follow_up_suppression",
  "dashboard_state_reconciliation",
  "provider_data_policy_and_zdr",
  "supabase_rls_and_secrets",
  "backup_and_migration_rollback",
  "named_release_owner",
  "requirement_traceability_195",
  "staging_no_real_writes",
  "read_only_faq_rag_smoke",
  "crm_persistence_smoke",
  "handover_smoke",
  "appointment_smoke_or_disabled",
  "follow_up_smoke_or_disabled",
  "monitored_cohort_and_metrics",
  "prompt_rollback",
  "knowledge_rollback",
  "fact_register_rollback",
  "code_rollback",
  "migration_rollback_rehearsal",
  "whatsapp_pause_switch",
  "calendar_pause_switch",
  "follow_up_pause_switch",
  "crm_write_pause_switch",
  "incident_owner_and_correction_plan"
]);

function normalizedIdentity(value) {
  return String(value || "").normalize("NFKD").toLocaleLowerCase("und")
    .replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function namesMayReferToSamePerson(left, right) {
  const leftTokens = normalizedIdentity(left);
  const rightTokens = normalizedIdentity(right);
  if (!leftTokens.length || !rightTokens.length) return false;
  const covers = (shorter, longer) => shorter.every((token) => longer.some((candidate) =>
    token === candidate || (token.length === 1 && candidate.startsWith(token))
  ));
  return covers(leftTokens, rightTokens) || covers(rightTokens, leftTokens);
}

function validateReleaseReadiness(packet, now = new Date()) {
  const errors = [];
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    errors.push("validation clock must be a valid Date");
  }
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { ready: false, errors: [...errors, "packet must be an object"], gates: REQUIRED_GATES };
  }
  if (typeof packet.releaseOwner !== "string" || !packet.releaseOwner.trim()) {
    errors.push("releaseOwner is required");
  }
  if (!Array.isArray(packet.gates)) {
    errors.push("gates must be an array");
  }
  const supplied = new Map();
  for (const gate of Array.isArray(packet.gates) ? packet.gates : []) {
    if (!gate || typeof gate.id !== "string" || supplied.has(gate.id)) {
      errors.push("each gate needs a unique string id");
      continue;
    }
    supplied.set(gate.id, gate);
  }
  for (const id of REQUIRED_GATES) {
    const gate = supplied.get(id);
    if (!gate) {
      errors.push(`${id}: evidence missing`);
      continue;
    }
    if (gate.status !== "pass") errors.push(`${id}: status must be pass (received ${String(gate.status)})`);
    if (typeof gate.evidence !== "string" || !gate.evidence.trim()) errors.push(`${id}: evidence reference missing`);
    if (typeof gate.verifiedBy !== "string" || !gate.verifiedBy.trim()) errors.push(`${id}: verifier missing`);
    else if (namesMayReferToSamePerson(packet.releaseOwner, gate.verifiedBy)) errors.push(`${id}: verifier must be independent of releaseOwner`);
    const isoTimestamp = typeof gate.verifiedAt === "string"
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(gate.verifiedAt);
    const verifiedAt = isoTimestamp ? Date.parse(gate.verifiedAt) : NaN;
    const canonical = Number.isFinite(verifiedAt) ? new Date(verifiedAt).toISOString() : "";
    const normalizedTimestamp = isoTimestamp && !gate.verifiedAt.includes(".")
      ? `${gate.verifiedAt.slice(0, -1)}.000Z` : gate.verifiedAt;
    if (!Number.isFinite(verifiedAt) || canonical !== normalizedTimestamp || verifiedAt > now.getTime()) {
      errors.push(`${id}: valid past UTC verifiedAt timestamp missing`);
    }
  }
  for (const id of supplied.keys()) {
    if (!REQUIRED_GATES.includes(id)) errors.push(`${id}: unknown gate`);
  }
  return { ready: errors.length === 0, errors, gates: REQUIRED_GATES };
}

if (require.main === module) {
  const fs = require("node:fs");
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("Usage: node scripts/validateReleaseReadiness.js <evidence-packet.json>\n");
    process.exitCode = 2;
  } else {
    try {
      const result = validateReleaseReadiness(JSON.parse(fs.readFileSync(path, "utf8")));
      process.stdout.write(`${result.ready ? "READY" : "NOT_READY"}: ${result.errors.length} finding(s)\n`);
      for (const error of result.errors) process.stdout.write(`- ${error}\n`);
      process.exitCode = result.ready ? 0 : 1;
    } catch {
      process.stderr.write("Invalid or unreadable evidence packet. No release decision made.\n");
      process.exitCode = 2;
    }
  }
}

module.exports = { REQUIRED_GATES, validateReleaseReadiness };
