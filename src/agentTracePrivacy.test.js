const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeAgentTraceFields } = require("./agentTracePrivacy");

test("safe trace survives identical Node and Edge contracts, including codes and non-UUID section refs", async () => {
  const { sanitizeAgentTraceFields: edge } = await import("../supabase/functions/rafa-agent-api/agentTracePrivacy.mjs");
  const fields = {
    traceId: "0c4cb90f-d7c6-432c-8521-144ea547ffed", step: 3,
    validationReasons: ["prohibited_claim", "anti_pattern:AP-2", "entities_not_in_evidence"],
    evidenceIds: ["0c4cb90f-d7c6-432c-8521-144ea547ffed:2", "03aa019aeccc547983749ecdef173481"],
    toolsUsed: ["searchApprovedKnowledge"], knowledgeStatus: "found", errorCode: "HTTP_503",
    evidenceAssemblyDurationMs: 4,
    toolCalls: [{ tool: "searchApprovedKnowledge", status: "error", ok: false, reasonCode: "KNOWLEDGE_UNAVAILABLE", data: "private" }],
    hiddenPrompt: "never store", draft: "private customer data", response: "never store",
    query: "case user@example.test +357 99123456 api_key=sk-supersecretvalue123456"
  };
  const node = sanitizeAgentTraceFields(fields);
  assert.deepEqual(edge(fields), node);
  assert.deepEqual(edge(node), node, "gateway re-sanitization preserves all safe fields");
  assert.equal(node.validationReasons.length, 3);
  assert.equal(node.evidenceIds.length, 2);
  assert.equal(node.toolsUsed[0], "searchApprovedKnowledge");
  assert.equal(node.knowledgeStatus, "found");
  assert.equal(node.evidenceAssemblyDurationMs, 4);
  assert.equal(node.toolCalls[0].reasonCode, "KNOWLEDGE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(node), /supersecret|99123456|user@example|never store|private/u);
});

test("reason arrays reject prose and evidence arrays reject contact identifiers", () => {
  assert.deepEqual(sanitizeAgentTraceFields({
    validationReasons: ["unsupported_claim", "private free text"],
    evidenceIds: ["123456789@s.whatsapp.net", "not-a-reference"],
    toolCalls: ["private", { tool: "searchApprovedKnowledge", args: { customerName: "Private" } }]
  }), { validationReasons: ["unsupported_claim"], evidenceIds: [], toolCalls: [{ tool: "searchApprovedKnowledge" }] });
});
