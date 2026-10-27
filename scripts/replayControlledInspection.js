"use strict";
// Administrator diagnostic replay; never delivers a message or writes a live record.
const fs = require("node:fs");
const path = require("node:path");
require("../src/env").loadProjectEnv(path.resolve(__dirname,".."));
const {buildGroundingReviewMessages,callGroundingReviewer,validateGroundingVerdict}=require("../src/semanticGrounding");
async function main(){
  const data=JSON.parse(fs.readFileSync("artifacts/whatsapp-postrestart-transcript.json"));
  const turn=process.argv[2] ? data.turns.find(t=>t.id===process.argv[2]) : data.turns.at(-1);
  if(!turn?.inspections?.length) throw new Error("Controlled inspection required");
  const inspection=turn.inspections.at(-1).inspection;
  const prior=data.turns.filter(t=>t.id!==turn.id && Date.parse(t.at)<Date.parse(turn.at) && Date.parse(t.at)>=Date.parse(data.activeSessionStartedAt)).slice(-6);
  const context={currentMessage:turn.message,locale:"arabic",recentConversation:prior.flatMap(t=>[{role:"user",content:t.message},{role:"assistant",content:t.response}])};
  const verdict=await callGroundingReviewer(buildGroundingReviewMessages({text:inspection.draft,evidenceItems:inspection.evidence,context}));
  const result=validateGroundingVerdict(verdict,inspection.draft,inspection.evidence,turn.message);
  fs.writeFileSync(`artifacts/controlled-replay-${Date.now()}.json`,JSON.stringify({traceId:turn.traceId,inspection,context,verdict,result},null,2));
  console.log(JSON.stringify({valid:result.valid,reasons:result.reasons,coverage:result.requestCoverage,claims:result.blockedClaims}));
  const expected=process.argv[3]!=="reject";
  if(result.valid!==expected || result.technicalFailure)process.exitCode=1;
}
main().catch(error=>{console.error(error.code||error.name);process.exitCode=1;});
