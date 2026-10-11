"use strict";
// Actual WhatsApp answer composition; persistence is isolated in memory and
// outbound delivery is disabled. Live approved retrieval/model calls only.
const fs = require("node:fs");
const path = require("node:path");
const { loadProjectEnv } = require("../src/env");
loadProjectEnv(path.resolve(__dirname, ".."));
const { MemoryStore } = require("../src/store");
const { createStore } = require("../src/supabaseStore");
const { runAgentLiveAnswerTurn } = require("../src/agentLiveAnswerTurn");
const { TOOL_REGISTRY } = require("../src/agentTools");
const { redactTraceText } = require("../src/agentTracePrivacy");
const { redactSensitiveData } = require("../src/sensitiveData");
const history = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../artifacts/whatsapp-audit-history.json"), "utf8"));
const cases = ["مرحبا، ممكن أعرف شو بتقدّموا خدمات بقبرص؟", "طيب أنا بدي أسّس شركة بس، مو مهتم بالاستثمار أو العقارات. بتساعدوني؟", "وشو بتقدروا تساعدوني فيه بعد ما تتأسس؟"];
const safe = (value) => typeof value === "string" ? redactTraceText(redactSensitiveData(value))
  : Array.isArray(value) ? value.map(safe)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)])) : value;
async function main() {
  const live = createStore();
  const report = [];
  for (const message of cases) {
    const memory = new MemoryStore();
    const user = memory.ensureUser("self-test:whatsapp-audit");
    const position = history.findIndex((turn) => turn.message === message);
    if (position < 0) throw new Error("Audit source turn missing");
    user.history = history.slice(0, position).map((turn) => ({ ...turn }));
    // Only the retrieval methods are forwarded to the live gateway. No live
    // contact/turn/workflow writes are possible from this store.
    for (const name of ["searchKnowledge", "lookupDynamicData"]) memory[name] = live[name].bind(live);
    memory.updateHistoryTurn = async (_id, id, patch) => Object.assign(user.history.find((turn) => turn.id === id), patch);
    const events = []; const rejections = []; let deliveredDraft = null;
    const start = Date.now();
    const result = await runAgentLiveAnswerTurn({ userId: user.id, chatId: "disabled", text: message }, {
      store: memory, toolRegistry: Object.fromEntries(Object.entries(TOOL_REGISTRY).filter(([name]) =>
        ["searchApprovedKnowledge", "lookupActiveOffer", "lookupRenewalFees", "lookupGovernmentFees"].includes(name))),
      logEvent: async (event, fields) => events.push({ event, fields }),
      sendStoredTextReply: async (_socket, _chat, response) => { deliveredDraft = response; },
      agentOptions: { onPolicyRejection: async (inspection) => rejections.push(inspection) }
    });
    report.push(safe({ message, priorHistory: history.slice(0, position), result, deliveredDraft, durationMs: Date.now() - start, events, rejections, outboundDisabled: true }));
    fs.writeFileSync(path.resolve(__dirname, "../artifacts/whatsapp-audit-reproduction.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ message, outcome: result.outcome, rejectionCount: rejections.length,
      reasons: rejections.map((item) => item.reasonCodes), durationMs: Date.now() - start }));
  }
}
main().catch((error) => { console.error(error.name, error.code || "REPRODUCTION_FAILED"); process.exitCode = 1; });
