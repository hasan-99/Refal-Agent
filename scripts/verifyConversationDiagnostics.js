"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadProjectEnv } = require("../src/env");
const { createStore } = require("../src/supabaseStore");
const { sanitizeControlledInspection } = require("../src/controlledDiagnostics");
loadProjectEnv(path.resolve(__dirname, ".."));
async function main() {
  const contactId = process.argv[2];
  if (!/^[a-f0-9-]{36}$/iu.test(contactId || "")) throw new Error("Verified test contact UUID required.");
  const store = createStore();
  const descriptor = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../artifacts/verified-qa-contact.json")));
  assert.equal(descriptor.contactId, contactId);
  const user = await store.getUser(descriptor.jid);
  assert.equal(user.profile.qaControlledDiagnostics, true);
  assert.equal(user.profile.followUpBlocked, true);
  const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../artifacts/whatsapp-audit-reproduction-baseline.json")))[0];
  const sourceTurn = user.history.find((turn) => turn.message === baseline.message);
  assert.ok(sourceTurn?.id);
  const traceId = randomUUID();
  const fields = { traceId, sourceTurnId: sourceTurn.id, step: 3, stage: "synthetic_contract_verification",
    durationMs: 7, evidenceCount: 2, tool: "searchApprovedKnowledge",
    validationReasons: ["prohibited_claim", "entities_not_in_evidence"],
    terminationCause: "validation_rejected", errorCode: "HTTP_503", draft: "MUST NOT ENTER ACTIVITY" };
  await store.logEvent("agent_diagnostic_contract_test", fields);
  const inspection = sanitizeControlledInspection({ ...baseline.rejections[0], traceId }, [user.id, user.phone, user.profile.name]);
  const saved = await store.saveControlledInspection(user.id, sourceTurn.id, inspection);
  const events = await store.listEvents({ limit: 3000 });
  const event = events.find((item) => item.traceId === traceId);
  assert.ok(event?.fields);
  assert.deepEqual(event.fields.validationReasons, fields.validationReasons);
  assert.equal(event.fields.durationMs, 7);
  assert.equal(event.fields.sourceTurnId, sourceTurn.id);
  assert.equal(event.fields.draft, undefined);
  assert.equal(events.some((item) => item.event === "agent_controlled_inspection"), false);
  const inspections = await store.listControlledInspections(user.id);
  const restored = inspections.find((item) => item.id === saved.inspectionId);
  assert.equal(restored.inspection.draft, inspection.draft);
  assert.deepEqual(restored.inspection.evidence, inspection.evidence);
  const report = { traceId, sourceTurnId: sourceTurn.id, inspectionId: saved.inspectionId, event: event.fields,
    exactDraftRestored: true, exactEvidenceRestored: true, stage: "synthetic_contract_verification", dashboardVerification: "pending" };
  fs.writeFileSync(path.resolve(__dirname, "../artifacts/diagnostics-live-verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch((error) => { console.error(error.name, error.code || error.status || "DIAGNOSTICS_FAILED"); process.exitCode = 1; });
