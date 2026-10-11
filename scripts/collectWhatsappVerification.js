"use strict";
// Read-only inspection of the previously verified owner test contact.
const fs = require("node:fs");
const path = require("node:path");
const { loadProjectEnv } = require("../src/env");
const { createStore } = require("../src/supabaseStore");
const { redactInspectionText } = require("../src/controlledDiagnostics");
loadProjectEnv(path.resolve(__dirname, ".."));
async function main() {
  const descriptor = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../artifacts/verified-qa-contact.json")));
  const store = createStore();
  const user = await store.getUser(descriptor.jid);
  const startedAt = user.profile.qaInitialVerificationStartedAt || user.profile.qaSessionStartedAt;
  if (!startedAt || user.profile.qaControlledDiagnostics !== true || user.profile.followUpBlocked !== true) throw new Error("Verified QA session required.");
  const events = await store.listEvents({ limit: 5000 });
  const inspections = await store.listControlledInspections(user.id);
  const turns = user.history.filter((turn) => Date.parse(turn.at) >= Date.parse(startedAt)).map((turn) => ({
    id: turn.id, at: turn.at, message: redactInspectionText(turn.message, [user.id, user.phone, user.profile.name]),
    response: redactInspectionText(turn.response, [user.id, user.phone, user.profile.name]), traceId: turn.metadata?.traceId,
    deliveredAt: turn.metadata?.whatsapp?.sentAt || null,
    events: events.filter((event) => event.fields?.sourceTurnId === turn.id || event.sourceTurnId === turn.id || (event.fields?.traceId || event.traceId) === turn.metadata?.traceId),
    inspections: inspections.filter((item) => item.sourceTurnId === turn.id)
  }));
  fs.writeFileSync(path.resolve(__dirname, "../artifacts/whatsapp-postrestart-transcript.json"), JSON.stringify({ startedAt, followUpBlocked: user.profile.followUpBlocked, turns }, null, 2));
  console.log(JSON.stringify({ count: turns.length, turns: turns.slice(-1).map((turn) => ({
    id: turn.id, message: turn.message, response: turn.response, deliveredAt: turn.deliveredAt, traceId: turn.traceId,
    events: turn.events.map((event) => { const f=event.fields || event; return { event: event.event, stage:f.stage, step:f.step,
      outcome:f.outcome, status:f.status, durationMs:f.durationMs, evidenceCount:f.evidenceCount,
      errorCode:f.errorCode, reasonCode:f.reasonCode, validationReasons:f.validationReasons }; }),
    inspections: turn.inspections.map((item) => ({ id:item.id, reasons:item.inspection.reasonCodes, draft:item.inspection.draft }))
  })) }));
}
main().catch((error) => { console.error(error.name, error.code || error.status || "INSPECTION_FAILED"); process.exitCode = 1; });
