"use strict";
// Controlled replay of the exact delivered draft and evidence; no transport or writes.
const fs = require("node:fs");
const path = require("node:path");
require("../src/env").loadProjectEnv(path.resolve(__dirname, ".."));
const { buildGroundingReviewMessages, callGroundingReviewer, validateGroundingVerdict } = require("../src/semanticGrounding");
async function main() {
  const turns = JSON.parse(fs.readFileSync("artifacts/whatsapp-postrestart-transcript.json")).turns;
  const turn = process.argv[2] ? turns.find(item=>item.id===process.argv[2]) : turns.at(-1);
  if(!turn) throw new Error("Source turn not found");
  const evidence = JSON.parse(fs.readFileSync("artifacts/turn3-scope-evidence.json")).map(x => ({ sourceRef:x.id, content:x.content, section:x.heading }));
  const context = { currentMessage:turn.message, locale:"arabic", recentConversation: turns.filter(t=>Date.parse(t.at)<Date.parse(turn.at)).slice(-2).flatMap(t => [{role:"user",content:t.message},{role:"assistant",content:t.response}]) };
  const verdict = await callGroundingReviewer(buildGroundingReviewMessages({ text:turn.response, evidenceItems:evidence, context }));
  const result = validateGroundingVerdict(verdict, turn.response, evidence);
  fs.writeFileSync("artifacts/comparative-grounding-live-replay.json",JSON.stringify({turnId:turn.id,context,evidence,draft:turn.response,verdict,result},null,2));
  console.log(JSON.stringify({valid:result.valid,reasons:result.reasons,blockedClaims:result.blockedClaims}));
  if(result.valid || result.technicalFailure) process.exitCode=1;
}
main().catch(error=>{console.error(error.code || error.name);process.exitCode=1;});
