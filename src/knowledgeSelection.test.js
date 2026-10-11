const test = require("node:test");
const assert = require("node:assert/strict");
const { selectKnowledgeSections } = require("./knowledgeSelection");
const { boundAccumulatedKnowledgeEvidence } = require("./agentLoop");

test("contextual selector handles multilingual requests and can select complementary sections without keyword mappings", async () => {
  for (const request of ["شو بتضلوا تعملوا معي بعد ما تجهز الشركة؟", "Once registered, what ongoing assistance is available?", "Μετά την ίδρυση, τι υποστήριξη προσφέρετε;"]) {
    const result = await selectKnowledgeSections({ currentMessage: request, history: [{ message: "I only need a company." }], candidates: [
      { title: "Tax residence", section: "Salary", content: "An unrelated passage" },
      { title: "Company lifecycle", section: "Ongoing assistance", content: "Approved conditions and assistance" },
      { title: "Company lifecycle", section: "Exceptions", content: "Conditions and exceptions" }
    ] }, { callModel: async (messages) => {
      const input = JSON.parse(messages[1].content); assert.equal(input.currentMessage, request); assert.equal(input.catalogue.length, 3);
      return { selections: [{ id: "1", relevance: 3 }, { id: "2", relevance: 2 }, { id: "999", relevance: 3 }] };
    } });
    assert.deepEqual(result.selections.map((item) => item.id), ["1", "2"]);
  }
});

test("higher relevance replaces weak early evidence, and omitted evidence remains distinct from genuinely new evidence", () => {
  const round = (ref, relevance, content) => ({ result: { modelObservation: { type: "approved_knowledge", evidence: [{ sourceRef: ref, relevance, content }], policyEvidence: [] } } });
  const weak = round("weak", 1, "w".repeat(150));
  const strong = round("strong", 3, "s".repeat(150));
  boundAccumulatedKnowledgeEvidence([weak], 250);
  const replaced = boundAccumulatedKnowledgeEvidence([weak, strong], 250);
  assert.deepEqual(replaced.retainedIds, ["strong"]); assert.deepEqual(replaced.replacedIds, ["weak"]);
  assert.deepEqual(replaced.excludedIds, ["weak"]); assert.equal(replaced.newCandidateCount, 1);
  const duplicate = round("weak", 1, "w".repeat(150));
  const retry = boundAccumulatedKnowledgeEvidence([weak, strong, duplicate], 250);
  assert.equal(retry.newCandidateCount, 0); assert.deepEqual(retry.retainedIds, ["strong"]);
  assert.equal(weak.result.modelObservation.candidateEvidence.length, 1);
});

test("UTF-8 evidence budgeting omits complete sections rather than truncating their exceptions", () => {
  const observation = { result: { modelObservation: { type: "approved_knowledge", evidence: [{ sourceRef: "arabic", content: "شروط واستثناءات".repeat(20) }], policyEvidence: [] } } };
  const result = boundAccumulatedKnowledgeEvidence([observation], 10000, 300);
  assert.equal(result.evidenceCount, 0); assert.deepEqual(result.excludedIds, ["arabic"]);
  assert.ok(observation.result.modelObservation.candidateEvidence[0].content.endsWith("استثناءات"));
});
