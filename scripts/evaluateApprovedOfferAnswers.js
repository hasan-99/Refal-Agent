"use strict";

// Read-only, live-model smoke for the approved dynamic formation offer.
// Uses synthetic questions and exposes only approved knowledge search and
// dynamic offer lookup; it never persists a contact or sends a message.
const path = require("node:path");
const fs = require("node:fs");
const { loadProjectEnv } = require("../src/env");

loadProjectEnv(path.resolve(__dirname, ".."));

const { runAgentTurnForContact } = require("../src/agentRuntime");
const { TOOL_REGISTRY } = require("../src/agentTools");
const { detectIntent } = require("../src/intent");
const { detectMessageLanguage } = require("../src/language");
const { DEFAULT_EMBEDDING_MODEL } = require("../src/ai");
const { createStore } = require("../src/supabaseStore");
const { validateResponse } = require("../src/responsePolicy");

const CASES = Object.freeze([
  { id: "formation_offer_price_en", language: "english", question: "What is the current price of your Cyprus company formation package, and what does it include?" },
  { id: "formation_offer_price_ar", language: "arabic", question: "كم سعر باقة تأسيس الشركة في قبرص حالياً، وشو بتشمل؟" },
  { id: "formation_offer_price_el", language: "greek", question: "Ποια είναι η τρέχουσα τιμή του πακέτου σύστασης εταιρείας στην Κύπρο και τι περιλαμβάνει;" }
]);
const READ_ONLY_TOOLS = Object.freeze(Object.fromEntries(
  ["searchApprovedKnowledge", "lookupActiveOffer"].map((name) => [name, TOOL_REGISTRY[name]])
));

function hasCurrentOfferLookup(result) {
  return Array.isArray(result?.steps) && result.steps.some((step) =>
    step?.tool === "lookupActiveOffer" && step.result?.status === "found"
      && step.result?.modelObservation?.type === "dynamic_data"
      && step.result?.modelObservation?.source === "trusted_edge_dynamic_read"
      && step.result?.modelObservation?.records?.some((record) =>
        record?.code === "formation-package" && record?.reviewStatus === "approved" && record?.active === true
          && Number.isFinite(Date.parse(record?.validUntil || "")) && Date.parse(record.validUntil) > Date.now()
      )
  );
}

async function evaluateCase(item, index, { store = createStore(), runTurn = runAgentTurnForContact } = {}) {
  const intents = detectIntent(item.question).intents;
  const user = { id: `qa-approved-offer-${item.language}-${index + 1}`, history: [], profile: {}, booking: null };
  const result = await runTurn({
    currentMessage: item.question,
    locale: item.language,
    user,
    userId: user.id,
    store,
    intents,
    language: item.language,
    embedText: async () => null,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    recentConversation: []
  }, { tools: READ_ONLY_TOOLS });
  const response = String(result?.response || "").trim();
  const checked = validateResponse(response, { customerMessage: item.question, maxQuestions: 1, maxChars: 1200 });
  const expectedLanguage = detectMessageLanguage(item.question);
  const actualLanguage = detectMessageLanguage(response);
  const errors = [];
  if (result?.outcome !== "responded") errors.push("agent_did_not_respond");
  if (!hasCurrentOfferLookup(result)) errors.push("approved_current_offer_not_observed");
  if (!response) errors.push("empty_response");
  if (!checked.valid) errors.push(`response_policy:${checked.reasons.join(",")}`);
  if (response.length > 80 && actualLanguage !== expectedLanguage) errors.push("response_language_mismatch");
  if (Array.isArray(result?.toolsUsed) && result.toolsUsed.some((name) =>
    !["searchApprovedKnowledge", "lookupActiveOffer"].includes(name)
  )) errors.push("non_read_only_tool_used");
  return {
    language: item.language,
    outcome: result?.outcome || "error",
    status: errors.length ? "FAIL" : "PASS",
    responseLength: response.length,
    responseLanguage: actualLanguage,
    toolsUsed: Array.isArray(result?.toolsUsed) ? result.toolsUsed : [],
    currentApprovedOfferObserved: hasCurrentOfferLookup(result),
    responsePolicyValid: checked.valid,
    errors
  };
}

function buildReport(results, generatedAt = new Date().toISOString()) {
  const safeResults = results.map((result, index) => ({
    caseId: CASES[index]?.id || `case-${index + 1}`,
    language: result?.language || null,
    outcome: result?.outcome || "error",
    status: result?.status || "ERROR",
    responseLength: Number.isSafeInteger(result?.responseLength) ? result.responseLength : null,
    responseLanguage: result?.responseLanguage || null,
    toolsUsed: Array.isArray(result?.toolsUsed) ? result.toolsUsed.filter((name) => Object.hasOwn(READ_ONLY_TOOLS, name)) : [],
    currentApprovedOfferObserved: result?.currentApprovedOfferObserved === true,
    responsePolicyValid: result?.responsePolicyValid === true,
    errors: Array.isArray(result?.errors) ? result.errors.map((error) => String(error).slice(0, 100)) : []
  }));
  return {
    schemaVersion: 1,
    generatedAt,
    testType: "live_model_read_only_approved_offer_smoke",
    runtime: "local Node Agent runtime with live Supabase reads and live model provider",
    scope: { syntheticQuestions: true, realCustomerData: false, contactWrites: false, customerSends: false,
      testedToolAllowlist: Object.keys(READ_ONLY_TOOLS), deployedEdgeRuntime: false },
    summary: { total: results.length, passed: results.filter((result) => result.status === "PASS").length,
      failed: results.filter((result) => result.status !== "PASS").length },
    results: safeResults
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for the live-model smoke.");
  const store = createStore();
  const results = [];
  for (const [index, item] of CASES.entries()) {
    try {
      results.push(await evaluateCase(item, index, { store }));
    } catch (error) {
      results.push({ language: item.language, status: "ERROR", errorKind: String(error?.message || error).includes("HTTP 401") ? "provider_auth" : "live_smoke_error" });
    }
  }
  const report = buildReport(results);
  const outputPath = path.resolve(__dirname, "../reports/release-readiness/approved-offer-live-smoke-latest.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Machine-readable evidence: ${path.relative(path.resolve(__dirname, ".."), outputPath)}`);
  for (const result of results) console.log(JSON.stringify(result));
  const passed = results.filter((result) => result.status === "PASS").length;
  console.log(`Approved-offer live answer smoke: ${passed}/${results.length} passed. Synthetic questions, live read-only offer lookup, no contact writes or customer sends.`);
  if (passed !== results.length) process.exitCode = 1;
  return results;
}

if (require.main === module) main().catch((error) => {
  console.error(`Approved-offer live answer smoke could not run: ${String(error?.message || error).slice(0, 180)}`);
  process.exitCode = 1;
});

module.exports = { CASES, READ_ONLY_TOOLS, hasCurrentOfferLookup, evaluateCase, buildReport };
