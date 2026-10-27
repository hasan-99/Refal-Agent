"use strict";
// Safe concise summary; the collector retains the complete correlated report.
const fs = require("node:fs");
const turn = JSON.parse(fs.readFileSync("artifacts/whatsapp-postrestart-transcript.json")).turns.at(-1);
const fields = e => e.fields || e;
const validation = turn.events.filter(e=>e.event==="agent_model_call" && fields(e).stage==="validation");
console.log(JSON.stringify({traceId:turn.traceId,deliveredAt:turn.deliveredAt,
  outcome:fields(turn.events.find(e=>e.event==="agent_turn_completed") || {}).outcome,
  validations:validation.map(e=>{ const v=fields(e);const g=fields(turn.events.find(x=>x.event==="agent_model_call" && fields(x).step===v.step && /^decision_(respond|clarify)$/.test(fields(x).outcome||"")) || {});
    return {step:v.step,outcome:v.outcome,evidenceCount:v.evidenceCount,evidenceMatchesGeneration:JSON.stringify([...(v.evidenceIds||[])].sort())===JSON.stringify([...(g.evidenceIds||[])].sort())}; }),
  failures:turn.events.filter(e=> /failed|not_clean/.test(e.event) || fields(e).outcome==="provider_error").map(e=>({event:e.event,...fields(e)})),
  rejections:turn.inspections.map(x=>({reasons:x.inspection.reasonCodes,claims:x.inspection.claims}))
}));
