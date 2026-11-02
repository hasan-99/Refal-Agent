const test = require("node:test");
const assert = require("node:assert/strict");

test("later relevant evidence replaces weaker evidence without deleting omitted candidate sections", () => {
  const { boundAccumulatedKnowledgeEvidence } = require("./agentLoop");
  const observation = (id, relevance, size) => ({ result: { modelObservation: { type: "approved_knowledge", evidence: [{ sourceRef: id, title: "Section", content: "x".repeat(size), relevance }], policyEvidence: [{ sourceRef: id, review_status: "approved" }] } } });
  const observations = [observation("weak", 1, 350)];
  boundAccumulatedKnowledgeEvidence(observations, 500);
  observations.push(observation("strong", 3, 350));
  const selected = boundAccumulatedKnowledgeEvidence(observations, 500);
  assert.deepEqual(selected.retainedIds, ["strong"]);
  assert.deepEqual(selected.replacedIds, ["weak"]);
  assert.equal(observations[0].result.modelObservation.candidateEvidence[0].content.length, 350);
  assert.equal(observations[1].result.modelObservation.policyEvidence[0].sourceRef, "strong");
  observations.push(observation("another", 2, 350));
  const omitted = boundAccumulatedKnowledgeEvidence(observations, 500);
  assert.equal(omitted.newCandidateCount, 1);
  assert.equal(omitted.newEvidenceCount, 0);
  assert.ok(omitted.excludedIds.includes("another"));
  assert.equal(observations[2].result.modelObservation.candidateEvidence.length, 1);
});

test("equal-ranked later search results do not evict earlier usable evidence", () => {
  const { boundAccumulatedKnowledgeEvidence } = require("./agentLoop");
  const row = (id) => ({
    result: { modelObservation: { type: "approved_knowledge", evidence: [
      { sourceRef: id, title: id, content: "x".repeat(350), relevance: 2, selectionOrder: 0 }
    ] } }
  });
  const observations = [row("earlier-approved-scope")];
  boundAccumulatedKnowledgeEvidence(observations, 500);
  observations.push(row("later-unrelated-result"));
  const budget = boundAccumulatedKnowledgeEvidence(observations, 500);
  assert.deepEqual(budget.retainedIds, ["earlier-approved-scope"]);
  assert.deepEqual(budget.excludedIds, ["later-unrelated-result"]);
  assert.equal(budget.newEvidenceCount, 0);
});

test("an equally ranked direct result from the latest primary search replaces stale context", () => {
  const { boundAccumulatedKnowledgeEvidence } = require("./agentLoop");
  const round = (id, primarySearchMatch = false) => ({ result: { modelObservation: {
    type: "approved_knowledge", primarySearchRefs: primarySearchMatch ? [id] : [], evidence: [
      { sourceRef: id, title: id, content: "x".repeat(350), relevance: 1, selectionOrder: 0 }
    ]
  } } });
  const observations = [round("earlier-topic")];
  boundAccumulatedKnowledgeEvidence(observations, 500);
  observations.push(round("current-primary-overview", true));
  const budget = boundAccumulatedKnowledgeEvidence(observations, 500);
  assert.deepEqual(budget.retainedIds, ["current-primary-overview"]);
  assert.deepEqual(budget.replacedIds, ["earlier-topic"]);
});

test("a strong earlier same-turn match survives query drift, but clearly stronger evidence replaces it", () => {
  const { boundAccumulatedKnowledgeEvidence } = require("./agentLoop");
  const round = (id, relevance, primarySearchMatch) => ({ result: { modelObservation: {
    type: "approved_knowledge", primarySearchRefs: primarySearchMatch ? [id] : [], evidence: [
      { sourceRef: id, title: id, content: "x".repeat(350), relevance, selectionOrder: 0 }
    ]
  } } });
  const observations = [round("residence-scope", 1, true)];
  boundAccumulatedKnowledgeEvidence(observations, 500);
  observations.push(round("formation-noise", 1, true));
  assert.deepEqual(boundAccumulatedKnowledgeEvidence(observations, 500).retainedIds, ["residence-scope"]);

  observations.push(round("specific-residence-conditions", 3, true));
  const stronger = boundAccumulatedKnowledgeEvidence(observations, 500);
  assert.deepEqual(stronger.retainedIds, ["specific-residence-conditions"]);
  assert.deepEqual(stronger.replacedIds, ["residence-scope"]);
});
const { runAgentTurn, validateDecision, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { buildAgentContext } = require("./agentContext");

test("a recap is composed from customer memory and approved evidence without another model generation", async () => {
  const context = buildAgentContext({
    currentMessage: "Please summarize what I told you and what Refalco's official information confirms.",
    locale: "english"
  });
  const history = [
    { message: "I'm planning a one-person design studio in Cyprus serving clients in Germany and France." },
    { message: "Which services does Refalco offer?" }
  ];
  const source = { source_name: "Approved service overview", source_url: "https://example.invalid/services",
    document_id: "service-overview", chunk_id: "service-overview-1", review_status: "approved",
    valid_until: "2099-01-01T00:00:00Z", content: "Refalco offers company formation and registration in Cyprus, corporate administration, and business consulting." };
  const observation = { step: 1, tool: "searchApprovedKnowledge", args: { query: "Refalco services" }, result: {
    ok: true, status: "found", modelObservation: require("./agentTools").buildApprovedKnowledgeObservation("found", [source])
  } };
  let generations = 0;
  const result = await require("./agentLoop").runAgentTurn(context, {
    initialObservations: [observation], recapHistory: history, tools: {},
    decideNextStep: async () => { generations += 1; return { type: "respond", text: "The answer must use the model." }; },
    assessDraft: async () => { throw new Error("local recap must not repeat LLM grounding review"); }
  });
  assert.equal(result.outcome, "responded", JSON.stringify({ reason: result.reason, response: result.response, steps: result.steps }));
  assert.equal(result.localRecap, true);
  assert.equal(generations, 0);
  assert.match(result.response, /one-person design studio/i);
  assert.match(result.response, /Approved information: Refalco offers company formation/i);
  assert.doesNotMatch(result.response, /\?/u);
});

const BASE_CONTEXT = buildAgentContext({ currentMessage: "What is the price to create a Cyprus company?", locale: "english" });

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test("DEFAULT_MAX_STEPS is a small bounded number, never unlimited", () => {
  assert.equal(DEFAULT_MAX_STEPS, 5);
});

test("model tool-name separators resolve only to one registered tool and invented tools stay rejected", async () => {
  assert.deepEqual(validateDecision({ type: "tool", tool: "search_approved_knowledge", args: { query: "package details" } },
    { searchApprovedKnowledge: {} }), { ok: true, type: "tool", tool: "searchApprovedKnowledge", args: { query: "package details" } });
  assert.equal(validateDecision({ type: "tool", tool: "Search-Approved-Knowledge", args: {} },
    { searchApprovedKnowledge: {} }).tool, "searchApprovedKnowledge");
  assert.equal(validateDecision({ type: "tool", tool: "deleteDatabase", args: {} },
    { searchApprovedKnowledge: {} }).reason, "unknown_tool_requested");

  const events = [];
  const result = await runAgentTurn(BASE_CONTEXT, {
    decideNextStep: async () => ({ type: "tool", tool: "person@example.com" }),
    tools: {},
    maxSteps: 1,
    onDecisionRejected: async (event) => events.push(event)
  });
  assert.equal(result.outcome, "invalid_decision");
  assert.deepEqual(events, [{ step: 1, reason: "unknown_tool_requested", requestedTool: null }]);
});

test("a broad retrieval retains evidence and leaves one focused search available", async () => {
  const decisions = [];
  const result = await runAgentTurn(BASE_CONTEXT, {
    decideNextStep: async ({ step, tools, observations }) => {
      decisions.push({ step, searchAvailable: Boolean(tools.searchApprovedKnowledge), evidenceCount: observations
        .flatMap((item) => item.result?.modelObservation?.evidence || []).length });
      return step === 1
        ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company overview" } }
        : { type: "clarify", text: "Which part would you like to explore?", tool: null, args: null };
    },
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", trace: { comprehensiveSearch: true }, modelObservation: {
      type: "approved_knowledge", status: "found", truncated: false,
      evidence: ["scope", "process", "limits"].map((sourceRef, selectionOrder) => ({ sourceRef, title: sourceRef,
        section: sourceRef, language: "english", content: `Complete ${sourceRef} section.`, selectionOrder })),
      policyEvidence: []
    } }) } },
    assessDraft: async () => ({ valid: true, reasons: [] })
  });
  assert.equal(result.outcome, "clarified");
  assert.deepEqual(decisions.map(({ step }) => step), [1, 2]);
  assert.equal(decisions[1].searchAvailable, true);
  assert.equal(decisions[1].evidenceCount, 3);
});

test("a focused second search can fill a gap after broad retrieval", async () => {
  const queries = [];
  const result = await runAgentTurn(BASE_CONTEXT, {
    maxSteps: 5,
    decideNextStep: async ({ step }) => step === 1
      ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "formation package overview" } }
      : step === 2
        ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "formation package processing duration" } }
        : { type: "respond", text: "The available details are ready to review." },
    tools: { searchApprovedKnowledge: { run: async ({ query }) => {
      queries.push(query);
      const sourceRef = queries.length === 1 ? "overview" : "duration";
      return { ok: true, status: "found", trace: { comprehensiveSearch: queries.length === 1 }, modelObservation: {
        type: "approved_knowledge", status: "found", evidence: [{ sourceRef, title: sourceRef, section: sourceRef,
          language: "english", content: `Approved ${sourceRef} information.` }], policyEvidence: []
      } };
    } } },
    assessDraft: async () => ({ valid: true, reasons: [] })
  });
  assert.deepEqual(queries, ["formation package overview", "formation package processing duration"]);
  assert.equal(result.outcome, "responded");
  assert.deepEqual(new Set(result.steps.flatMap(item => item.result?.modelObservation?.evidence || []).map(item => item.sourceRef)), new Set(["overview", "duration"]));
});

test("a failed knowledge search is reported as technical and is not repeated", async () => {
  let decisions = 0;
  let searches = 0;
  const toolEvents = [];
  const result = await runAgentTurn(BASE_CONTEXT, {
    maxSteps: 4,
    decideNextStep: async ({ tools }) => {
      decisions += 1;
      assert.equal(Boolean(tools.searchApprovedKnowledge), decisions === 1);
      return { type: "tool", tool: "searchApprovedKnowledge", args: { query: `attempt ${decisions}` } };
    },
    tools: { searchApprovedKnowledge: { run: async () => {
      searches += 1;
      return { ok: false, status: "error", reasonCode: "EDGE_TIMEOUT", trace: { providerStatus: 503, providerErrorCode: "UPSTREAM_UNAVAILABLE" } };
    } } },
    onToolCall: async (event) => toolEvents.push(event)
  });

  assert.equal(searches, 1);
  assert.equal(decisions, 2, "the model receives the technical failure once before repeated work stops");
  assert.equal(result.outcome, "knowledge_unavailable");
  assert.equal(result.reason, "EDGE_TIMEOUT");
  assert.equal(result.steps.at(-1).result.status, "search_unavailable");
  assert.equal(toolEvents[0].providerStatus, 503);
  assert.equal(toolEvents[0].providerErrorCode, "UPSTREAM_UNAVAILABLE");
});

test("a rejected draft after a failed search stops without repeating model validation", async () => {
  let decisions = 0;
  let reviews = 0;
  const result = await runAgentTurn(BASE_CONTEXT, {
    maxSteps: 5,
    decideNextStep: async () => decisions++ === 0
      ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company services" } }
      : { type: "respond", text: "I cannot summarize the services while the information source is unavailable." },
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: false, status: "error", reasonCode: "EDGE_TIMEOUT" }) } },
    assessDraft: async () => { reviews += 1; return { valid: false, reasons: ["context_mismatch", "question_not_answered"] }; }
  });

  assert.equal(decisions, 2);
  assert.equal(reviews, 1, "a technical retrieval failure without evidence cannot make repeated reviews productive");
  assert.equal(result.outcome, "knowledge_unavailable");
  assert.equal(result.reason, "EDGE_TIMEOUT");
});

test("a failed follow-up search preserves previously retrieved approved evidence", async () => {
  const evidence = { sourceRef: "approved-formation-scope", title: "Formation scope",
    content: "The company formation package includes a registered office for four months.", relevance: 1 };
  let decisionCount = 0;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "What does the package include?", locale: "english" }), {
    maxSteps: 3,
    initialObservations: [{ step: 0, tool: "searchApprovedKnowledge", args: { query: "package" }, result: {
      ok: true, status: "found", modelObservation: { type: "approved_knowledge", status: "found", evidence: [evidence], policyEvidence: [] }
    } }],
    decideNextStep: async () => {
      decisionCount += 1;
      return decisionCount === 1
        ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "registered office period" } }
        : { type: "respond", text: evidence.content };
    },
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: false, status: "error", reasonCode: "EDGE_TIMEOUT" }) } }
  });

  assert.equal(result.outcome, "responded");
  assert.equal(result.response, evidence.content);
  assert.equal(result.steps[1].result.status, "error");
});

test("a failed additional search still allows an answer from evidence found earlier this turn", async () => {
  const evidence = { sourceRef: "approved-formation-scope", title: "Formation scope",
    content: "The approved package includes company formation and a registered office for four months.", relevance: 1 };
  let searchCalls = 0;
  let decisionCount = 0;
  const result = await runAgentTurn(buildAgentContext({
    currentMessage: "Please list the relevant options. I do not want to book.", locale: "english"
  }), {
    maxSteps: 5,
    decideNextStep: async ({ tools: availableTools, observations }) => {
      decisionCount += 1;
      if (decisionCount <= 2) {
        return { type: "tool", tool: "searchApprovedKnowledge", args: { query: decisionCount === 1 ? "formation options" : "formation package inclusions" } };
      }
      if (decisionCount === 3) {
        assert.equal(availableTools.searchApprovedKnowledge, undefined, "a failed retrieval must not be retried");
        return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "booking" } };
      }
      assert.match(JSON.stringify(observations), /approved-formation-scope/);
      return { type: "respond", text: evidence.content };
    },
    tools: { searchApprovedKnowledge: { run: async () => {
      searchCalls += 1;
      if (searchCalls === 1) return { ok: true, status: "found", data: [evidence],
        modelObservation: { type: "approved_knowledge", status: "found", evidence: [evidence], policyEvidence: [] } };
      return { ok: false, status: "error", reasonCode: "EDGE_TIMEOUT" };
    } } }
  });

  assert.equal(searchCalls, 2);
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, evidence.content);
  assert.equal(result.reason, undefined);
  assert.ok(result.steps.some((item) => item.result?.reasonCode === "EDGE_TIMEOUT"));
});

test("unsupported comparisons receive focused correction guidance without an evidence disclaimer", async () => {
  const rejected = "Yes, we offer other service areas beyond those.";
  const recovered = "Those are the connected service areas we discussed. Is there a particular service you have in mind?";
  let calls = 0;
  const result = await runAgentTurn(buildAgentContext({
    currentMessage: "Are those all your services, or are there other areas too?", locale: "english",
    recentConversation: [
      { role: "user", content: "What services do you offer?" },
      { role: "assistant", content: "We help with company formation, tax and accounting, investment and property, and residency and relocation." }
    ]
  }), {
    maxSteps: 3,
    decideNextStep: async ({ observations }) => {
      if (calls++ === 0) return { type: "respond", text: rejected };
      const feedback = observations.find((item) => item.tool === "responsePolicyCheck");
      assert.ok(feedback);
      assert.equal(feedback.result.reasonCode, "unsupported_relation");
      assert.match(feedback.result.correction, /Remove only that claim/);
      assert.match(feedback.result.correction, /avoid repeating details already given/);
      assert.match(feedback.result.correction, /generic disclaimer about what you can confirm/);
      return { type: "respond", text: recovered };
    },
    assessDraft: async ({ text }) => text === rejected
      ? { valid: false, reasons: ["unsupported_relation"], blockedClaims: [{ sentence: rejected, reasons: ["unsupported_relation"] }] }
      : { valid: true }
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, recovered);
});

test("personalized conclusions receive neutral evidence-backed correction guidance", async () => {
  let feedback;
  const { runAgentTurn } = require("./agentLoop");
  const { buildAgentContext } = require("./agentContext");
  let calls = 0;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "How does company registration work?", locale: "english" }), {
    maxSteps: 2,
    decideNextStep: async ({ observations }) => {
      if (calls++ === 0) return { type: "respond", text: "With us, we will register your company." };
      feedback = observations.find((item) => item.tool === "responsePolicyCheck");
      return { type: "respond", text: "Company registration starts with the approved name and filing steps." };
    },
    assessDraft: async () => ({ valid: false, reasons: ["personalized_marker"],
      blockedClaims: [{ sentence: "With us, we will register your company.", reasons: ["personalized_marker"] }] }),
  });
  assert.equal(result.outcome, "response_rejected");
  assert.match(feedback.result.correction, /Replace it with neutral, evidence-backed information/u);
  assert.match(feedback.result.correction, /unless approved service evidence directly supports that commitment/u);
});

test("combined comparison and context rejection directs the agent to remove the repeated span", async () => {
  const draft = "The areas are broader than company formation. We provide company formation, tax, investment, property, and residency services.";
  const response = "Those are the connected areas we discussed. Is there a specific service you have in mind?";
  let calls = 0;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "Are those all your services?", locale: "english",
    recentConversation: [{ role: "assistant", content: "We provide company formation, tax, investment, property, and residency services." }] }), {
    maxSteps: 3,
    decideNextStep: async ({ observations }) => {
      if (calls++ === 0) return { type: "respond", text: draft };
      const feedback = observations.find((item) => item.tool === "responsePolicyCheck");
      assert.equal(feedback.result.reasonCode, "unsupported_relation,context_mismatch");
      assert.match(feedback.result.correction, /remove the full rejected repeat/);
      assert.match(feedback.result.correction, /do not restate it in new words, bullets or translation/);
      return { type: "respond", text: response };
    },
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["unsupported_relation", "context_mismatch"], blockedClaims: [{ sentence: draft, reasons: ["unsupported_relation", "context_mismatch"] }] }
      : { valid: true }
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, response);
});

test("rejection feedback keeps an unanswered request actionable when the draft also has an unsupported relation", async () => {
  const draft = "Those are the areas related to our services.";
  let calls = 0;
  const result = await runAgentTurn(buildAgentContext({
    currentMessage: "Are those all your services, or are there other areas too?", locale: "english"
  }), {
    maxSteps: 2,
    decideNextStep: async ({ observations }) => {
      if (calls++ === 0) return { type: "respond", text: draft };
      const feedback = observations.find(item => item.tool === "responsePolicyCheck");
      assert.equal(feedback.result.reasonCode, "unsupported_relation,question_not_answered");
      assert.match(feedback.result.correction, /Answer every unanswered part of the customer's current request explicitly/);
      assert.match(feedback.result.correction, /A follow-up question does not replace that answer/);
      return { type: "respond", text: "The overview names the connected areas discussed and does not describe another separate service area." };
    },
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["unsupported_relation", "question_not_answered"], blockedClaims: [
        { sentence: draft, reasons: ["unsupported_relation"] },
        { sentence: "Are those all your services, or are there other areas too?", claimClass: "UNMET_REQUEST", reasons: ["question_not_answered"] }
      ] }
      : { valid: true }
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "responded");
});

test("service attribution rejection preserves supported process facts as a partial answer", async () => {
  const rejected = "We prepare and submit the bank application for you.";
  const recovered = "The institution reviews the company, owners and fund flow and makes the decision. I can't confirm which preparation or submission steps REFAL handles, and approval is not guaranteed.";
  let calls = 0;
  const result = await runAgentTurn(buildAgentContext({
    currentMessage: "How can you help with a company bank account, and is approval guaranteed?", locale: "english"
  }), {
    maxSteps: 2,
    decideNextStep: async ({ observations }) => {
      if (calls++ === 0) return { type: "respond", text: rejected };
      const feedback = observations.find(item => item.tool === "responsePolicyCheck");
      assert.equal(feedback.result.reasonCode, "service_not_established");
      assert.match(feedback.result.correction, /describes a process but does not establish that REFAL performs/u);
      assert.match(feedback.result.correction, /Keep useful process facts that the current-turn evidence states/u);
      assert.match(feedback.result.correction, /Preserve any supported answer about outcomes or guarantees/u);
      return { type: "respond", text: recovered };
    },
    assessDraft: async ({ text }) => text === rejected
      ? { valid: false, reasons: ["service_not_established"], blockedClaims: [{ sentence: rejected, reasons: ["service_not_established"] }] }
      : { valid: true }
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, recovered);
});

test("mixed unsupported-service and unsupported-detail feedback preserves neutral process facts", async () => {
  const { policyRejectionObservation } = require("./agentLoop");
  const observation = policyRejectionObservation(2, "respond", {
    reasons: ["no_approved_evidence", "service_not_established"],
    blockedClaims: [{ sentence: "We submit the bank application", reasons: ["service_not_established"] }]
  }, ["no_approved_evidence", "service_not_established"], [{ tool: "searchApprovedKnowledge" }]);
  const correction = observation.result.correction;
  assert.match(correction, /neutral process facts only when current-turn evidence states them/u);
  assert.match(correction, /do not attribute the process to REFAL without explicit service evidence/u);
});

test("package price feedback accepts approved RAG and Active Offer without treating either as mandatory", () => {
  const { policyRejectionObservation } = require("./agentLoop");
  const observation = policyRejectionObservation(2, "respond", {
    reasons: ["unsupported_price_claim", "unverified_current_offer_claim"]
  }, ["unsupported_price_claim", "unverified_current_offer_claim"]);
  assert.match(observation.result.correction, /approved, currently valid RAG pricing evidence or a validated current Active Offer/u);
  assert.match(observation.result.correction, /Active Offer is an additional source, not a prerequisite/u);
  assert.match(observation.result.correction, /valid authoritative sources conflict/u);
});

test("attachment review rejection preserves file evidence and corrects attribution without inventing a handover", () => {
  const { policyRejectionObservation } = require("./agentLoop");
  const observation = policyRejectionObservation(1, "respond", {
    reasons: ["attachment_not_attributed", "unsupported_relation", "context_mismatch"],
    blockedClaims: [{ sentence: "The file is a checklist.", reasons: ["attachment_not_attributed"] }]
  }, ["attachment_not_attributed", "unsupported_relation", "context_mismatch"], [], {}, {
    attachmentReviewContinuation: true,
    attachmentContent: "Synthetic agenda. The proposed meeting time is 9:30 AM. The date and task owners are not listed."
  });
  assert.match(observation.result.correction, /attribute it plainly to the file/u);
  assert.match(observation.result.correction, /using the extracted attachment content retained in context/u);
  assert.match(observation.result.correction, /continue it without asking what to review again/u);
  assert.match(observation.result.correction, /Never claim that a team review or handover was recorded/u);
  assert.match(observation.result.correction, /Do not replace a valid file summary with a generic approved-information fallback/u);
  assert.doesNotMatch(observation.result.correction, /ask for a specific area only when useful/u);
});

test("pending document-review rejection retries the existing task instead of company-information fallback", () => {
  const { policyRejectionObservation } = require("./agentLoop");
  const observation = policyRejectionObservation(1, "respond", {
    text: "I do not have approved information about that detail.",
    reasons: ["context_mismatch"], blockedClaims: []
  }, ["context_mismatch"], [], {}, { attachmentReviewPending: true });
  assert.match(observation.result.correction, /already asked for a document review/u);
  assert.match(observation.result.correction, /invite the upload/u);
  assert.match(observation.result.correction, /Do not switch to company-information uncertainty/u);
});

test("a newly queued attachment stops retries after the first pending-review rejection", async () => {
  for (const type of ["clarify", "respond"]) {
    let decisions = 0;
    let reviews = 0;
    const result = await require("./agentLoop").runAgentTurn({ currentMessage: "Please review the document I will send.",
      locale: "english", attachmentReviewPending: true }, {
      maxSteps: 4,
      decideNextStep: async () => { decisions += 1; return { type, text: "Please attach the document so I can review it." }; },
      assessDraft: async () => { reviews += 1; return { valid: false, reasons: ["context_mismatch", "question_not_answered"], blockedClaims: [] }; },
      shouldStopAfterRejection: async () => true
    });
    assert.equal(decisions, 1, `${type} retry stopped`);
    assert.equal(reviews, 1, `${type} reviewed once`);
    assert.equal(result.outcome, "response_suppressed");
  }
});

test("attachment grounding rejection retries with retained file content and returns the corrected review", async () => {
  const attachmentContent = "Synthetic agenda. The proposed meeting time is 9:30 AM. Topics: meeting goal and task allocation. The date and task owners are not listed.";
  const rejected = "It is an agenda for a meeting at 9:30 AM.";
  const recovered = "بحسب الملف المرفق، هذا جدول أعمال لاجتماع مقترح الساعة ٩:٣٠، ويتناول هدف الاجتماع وتوزيع المهام. لا يحدد الملف التاريخ أو المسؤولين عن المهام.";
  const corrections = [];
  let generations = 0;
  const { runAgentTurn } = require("./agentLoop");
  const context = {
    currentMessage: "",
    locale: "arabic",
    attachmentContent,
    attachmentReviewContinuation: true,
    recentConversation: [{ role: "user", content: "ممكن تراجعلي المستند المرفق وتلخّص محتواه؟" }]
  };
  const result = await runAgentTurn(context, {
    maxSteps: 4,
    decideNextStep: async ({ observations }) => {
      generations += 1;
      const correction = observations.find((item) => item.tool === "responsePolicyCheck")?.result?.correction;
      if (correction) {
        corrections.push(correction);
        assert.match(correction, /extracted attachment content retained in context/u);
        assert.match(correction, /without asking what to review again/u);
      }
      return { type: "respond", text: generations === 1 ? rejected : recovered };
    },
    assessDraft: async ({ text, context: draftContext }) => {
      assert.equal(draftContext.attachmentContent, attachmentContent);
      return text === recovered ? { valid: true } : {
        valid: false,
        reasons: ["attachment_not_attributed"],
        blockedClaims: [{ sentence: rejected, reasons: ["attachment_not_attributed"] }]
      };
    }
  });
  assert.equal(generations, 2);
  assert.equal(corrections.length, 1);
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, recovered);
  assert.doesNotMatch(result.response, /معلومات معتمدة|ما عندي معلومات/u);
});

test("attachment attribution rejection is repaired and revalidated without generating an equivalent retry", async () => {
  const attachmentContent = "Synthetic document. The proposed meeting is at 9:30 AM.";
  const draft = "The document is a meeting agenda and gives a proposed time of 9:30 AM.";
  let generations = 0;
  const assessed = [];
  const result = await require("./agentLoop").runAgentTurn({ currentMessage: "", locale: "english", attachmentContent, attachmentReviewContinuation: true,
    recentConversation: [{ role: "user", content: "Please review the attached document." }] }, {
    maxSteps: 1,
    decideNextStep: async () => { generations += 1; return { type: "respond", text: draft }; },
    assessDraft: async ({ text }) => { assessed.push(text); return text.startsWith("According to the attached file,") ? { valid: true } : {
      valid: false,
      reasons: ["attachment_not_attributed"],
      blockedClaims: [{ sentence: draft, reasons: ["attachment_not_attributed"] }]
    }; }
  });
  assert.equal(generations, 1);
  assert.equal(result.outcome, "responded", JSON.stringify({ reason: result.reason, response: result.response, steps: result.steps, assessed }));
  assert.match(result.response, /^According to the attached file,/u);
  assert.doesNotMatch(result.response, /approved information|I cannot confirm/u);
});

test("attachment repair attributes multiple claims once per sentence", async () => {
  const attachmentContent = "Synthetic minutes list project tasks but do not name owners.";
  const draft = "The file lists the project tasks and does not name owners.";
  const firstClaim = "The file lists the project tasks";
  const secondClaim = "does not name owners";
  const result = await require("./agentLoop").runAgentTurn({ currentMessage: "", locale: "english", attachmentContent, attachmentReviewContinuation: true,
    recentConversation: [{ role: "user", content: "Please review the attached minutes." }] }, {
    maxSteps: 1,
    decideNextStep: async () => ({ type: "respond", text: draft }),
    assessDraft: async ({ text }) => text.startsWith("According to the attached file,")
      && !text.includes("and According to the attached file,") ? { valid: true } : {
        valid: false,
        reasons: ["attachment_not_attributed"],
        blockedClaims: [firstClaim, secondClaim].map((sentence) => ({ sentence, reasons: ["attachment_not_attributed"] }))
      }
  });
  assert.equal(result.outcome, "responded");
  assert.equal((result.response.match(/According to the attached file,/gu) || []).length, 1);
  assert.match(result.response, /lists the project tasks and does not name owners/u);
});

test("a repeated missing-approved-evidence rejection can recover as a file-attributed statement after review", async () => {
  const attachmentContent = "Synthetic document. Meeting agenda for a project planning session.";
  const draft = "This is a meeting agenda for a project planning session.";
  let generations = 0;
  const result = await require("./agentLoop").runAgentTurn({ currentMessage: "", locale: "english", attachmentContent, attachmentReviewContinuation: true,
    recentConversation: [{ role: "user", content: "Please review the attached document." }] }, {
    maxSteps: 4,
    decideNextStep: async () => { generations += 1; return { type: "respond", text: draft }; },
    assessDraft: async ({ text }) => text.startsWith("According to the attached file,") ? { valid: true } : {
      valid: false,
      reasons: ["no_approved_evidence"],
      blockedClaims: [{ sentence: draft, reasons: ["no_approved_evidence"] }]
    }
  });
  assert.equal(generations, 2);
  assert.equal(result.outcome, "responded", JSON.stringify({ reason: result.reason, response: result.response }));
  assert.match(result.response, /^According to the attached file,/u);
  assert.doesNotMatch(result.response, /approved information|I cannot confirm/u);
});

test("a no-evidence rejection routes general company facts to one knowledge search before fallback", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "formation-doc", section_index: "1", chunk_id: "package", chunk_index: 0,
    document_title: "Approved formation package", heading: "Company formation", content: "Refalco Group's Cyprus Ltd formation package includes name reservation, preparation and filing of formation documents, the certificate of incorporation, and company secretary and registered address for four months.", review_status: "approved" };
  const reply = "The Cyprus Ltd formation package includes name reservation, preparation and filing of formation documents, the certificate of incorporation, and company secretary and registered address for four months.";
  const calls = [];
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "What does the company formation package include?", locale: "english" }), {
    maxSteps: 4,
    tools: {
      lookupActiveOffer: { run: async () => ({ ok: true, status: "found", modelObservation: { type: "dynamic_data", evidence: [] } }) },
      searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", data: [source], modelObservation: buildApprovedKnowledgeObservation("found", [source]) }) }
    },
    decideNextStep: async ({ step, observations }) => {
      calls.push(step);
      if (step === 1) return { type: "tool", tool: "lookupActiveOffer", args: {} };
      if (step === 2) return { type: "respond", text: "I need to check the approved details before I can confirm the package." };
      if (step === 3) {
        const rejection = observations.find((item) => item.tool === "responsePolicyCheck");
        assert.match(rejection.result.correction, /Use searchApprovedKnowledge/);
        assert.match(rejection.result.correction, /live-offer lookup does not establish general service scope/);
        return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation package inclusions" } };
      }
      return { type: "respond", text: reply };
    },
    assessDraft: async ({ text }) => text === reply ? { valid: true } : { valid: false, reasons: ["no_approved_evidence"] }
  });
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, reply);
  assert.deepEqual(result.toolsUsed, ["lookupActiveOffer", "searchApprovedKnowledge"]);
});

test("a repeated unsupported claim stops when its approved evidence has not changed", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "scope-doc", section_index: "1", chunk_id: "scope", chunk_index: 0,
    document_title: "Approved scope", heading: "Services", content: "Refalco Group offers company formation.", review_status: "approved" };
  const firstDraft = "Refalco Group offers company formation. Residency follows a separate route with its own requirements";
  const secondDraft = "For company formation, Refalco Group can help. Residency follows a separate route with its own requirements";
  let calls = 0;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "Summarize what is relevant to me.", locale: "english" }), {
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", data: [source],
      modelObservation: buildApprovedKnowledgeObservation("found", [source]) }) } },
    decideNextStep: async ({ step, observations }) => {
      calls += 1;
      if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company services" } };
      if (step === 2) return { type: "respond", text: firstDraft };
      const feedback = observations.find((item) => item.tool === "responsePolicyCheck");
      assert.match(feedback.result.correction, /one focused search/);
      assert.match(feedback.result.correction, /remove that span/);
      return { type: "respond", text: secondDraft };
    },
    assessDraft: async ({ text }) => text === firstDraft || text === secondDraft
      ? { valid: false, reasons: ["prohibited_claim"], blockedClaims: [
        { sentence: "Residency follows a separate route with its own requirements.", reasons: ["entities_not_in_evidence", "number_not_in_evidence:15"] }
      ] }
      : { valid: true }
  });
  assert.equal(calls, 3);
  assert.equal(result.outcome, "response_rejected");
  assert.equal(result.reason, "repeated_blocked_claim_without_evidence_progress");
  assert.equal(result.stepCount, 3);
  assert.match(result.response, /approved information to confirm that detail/u);
  assert.match(result.response, /won’t guess/u);
});

test("repeated unsupported comparison evidence returns a validated grounded partial answer", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "cyprus", section_index: 0, chunk_id: "cyprus-process", document_title: "Cyprus formation",
    heading: "Formation", content: "Cyprus company formation includes preparation and filing of incorporation documents.", relevance: 1 };
  const evidence = buildApprovedKnowledgeObservation("found", [source]);
  const draft = "Cyprus formation includes preparation and filing of incorporation documents. Malta offers a faster process for this business type.";
  const blocked = "Malta offers a faster process for this business type.";
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "Compare Cyprus and Malta for my business.", locale: "english" }), {
    maxSteps: 5,
    initialObservations: [{ step: 0, tool: "searchApprovedKnowledge", args: { query: "Cyprus formation" }, result: { ok: true, status: "found", modelObservation: evidence } }],
    decideNextStep: async ({ step }) => step === 1 ? { type: "respond", text: draft }
      : step === 2 ? { type: "tool", tool: "searchApprovedKnowledge", args: { query: "Malta formation comparison" } }
        : { type: "respond", text: draft },
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "no_evidence", modelObservation: buildApprovedKnowledgeObservation("no_evidence", []) }) } },
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["unsupported_relation"], blockedClaims: [{ sentence: blocked, reasons: ["no_approved_evidence", "unsupported_relation"] }] }
      : { valid: true }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "Cyprus formation includes preparation and filing of incorporation documents.");
  assert.equal(result.stepCount, 3);
});

test("an evidence-only rejection can preserve and revalidate the supported partial answer", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "scope-doc", section_index: "1", chunk_id: "scope", chunk_index: 0,
    document_title: "Approved scope", heading: "Services", content: "Refalco Group offers company formation and tax and accounting services.", review_status: "approved" };
  const unsupported = "We also prepare payroll registrations.";
  const draft = `Refalco Group offers company formation and tax and accounting services. ${unsupported}`;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "Summarize the relevant services.", locale: "english" }), {
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", data: [source],
      modelObservation: buildApprovedKnowledgeObservation("found", [source]) }) } },
    decideNextStep: scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company services" } },
      { type: "respond", text: draft }
    ]),
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["prohibited_claim"] }
      : { valid: true }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "Refalco Group offers company formation and tax and accounting services.");
  assert.equal(result.stepCount, 2);
});

test("an individualized eligibility clause is removed while the grounded summary is revalidated", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "scope-doc", section_index: "1", chunk_id: "scope", chunk_index: 0,
    document_title: "Approved scope", heading: "Services", content: "Refalco Group offers company formation.", review_status: "approved" };
  const unsupported = "Your residence eligibility depends on the route.";
  const draft = `Refalco Group offers company formation. ${unsupported}`;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "Summarize the relevant services.", locale: "english" }), {
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", data: [source],
      modelObservation: buildApprovedKnowledgeObservation("found", [source]) }) } },
    decideNextStep: scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company services" } },
      { type: "respond", text: draft }
    ]),
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["personalized_marker"], blockedClaims: [{ sentence: unsupported, reasons: ["personalized_marker"] }] }
      : { valid: true }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "Refalco Group offers company formation.");
});

test("a rejected trailing span after a semicolon is rewritten before delivery", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "scope-doc", section_index: "1", chunk_id: "scope", chunk_index: 0,
    document_title: "Approved scope", heading: "Services", content: "Residency and relocation are separate service areas.", review_status: "approved" };
  const unsupported = "forming a company alone does not establish whether you qualify for residency, and the specific inclusions of those services aren’t detailed here.";
  const draft = `Residency and relocation are separate service areas; ${unsupported}`;
  const rewritten = "Residency and relocation are separate service areas. The supplied information does not establish whether Refalco Group provides the additional service you asked about.";
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "What about residency?", locale: "english" }), {
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", data: [source],
      modelObservation: buildApprovedKnowledgeObservation("found", [source]) }) } },
    decideNextStep: scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "residency services" } },
      { type: "respond", text: draft },
      { type: "respond", text: rewritten }
    ]),
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["personalized_marker"], blockedClaims: [{ sentence: unsupported, reasons: ["personalized_marker"] }] }
      : { valid: true }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, rewritten);
  assert.doesNotMatch(result.response, /[;,:]$/u);
});

test("an Arabic guarantee refusal with a rejected trailing clause is not delivered as a semicolon fragment", async () => {
  const draft = "ما في ربح مضمون أقدر أؤكده على استثمار ١٠٠ ألف؛ العائد يعتمد على الاستثمار ومخاطره، وما بقدر أقدّم ضمانًا أو توقعًا ماليًا.";
  const rewritten = "ما عندي معلومات موثوقة تحدد ربحًا مضمونًا لاستثمار ١٠٠ ألف. إذا عندك استثمار محدد ببالك، فيني أساعدك بالمعلومات المعتمدة عنه.";
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "إذا استثمرت ١٠٠ ألف، قديش الربح المضمون؟", locale: "arabic" }), {
    decideNextStep: scriptedDecider([
      { type: "respond", text: draft },
      { type: "respond", text: rewritten }
    ]),
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["no_approved_evidence"], blockedClaims: [
        { sentence: "العائد يعتمد على الاستثمار ومخاطره، وما بقدر أقدّم ضمانًا أو توقعًا ماليًا.", reasons: ["no_approved_evidence"] }
      ] }
      : { valid: true }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, rewritten);
  assert.doesNotMatch(result.response, /[;،:]$/u);
});

test("a claim that a topic is an established service is removed while supported answer content is preserved", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "scope-doc", section_index: "1", chunk_id: "scope", chunk_index: 0,
    document_title: "Approved scope", heading: "Services", content: "Refalco Group provides company formation and corporate support.", review_status: "approved" };
  const unsupported = "We also provide partner-change support.";
  const supported = "Refalco Group provides company formation and corporate support.";
  const draft = `${supported} ${unsupported}`;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "Can you summarize the relevant services?", locale: "english" }), {
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", data: [source],
      modelObservation: buildApprovedKnowledgeObservation("found", [source]) }) } },
    decideNextStep: scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company services" } },
      { type: "respond", text: draft }
    ]),
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["service_not_established"], blockedClaims: [{ sentence: unsupported, reasons: ["service_not_established"] }] }
      : { valid: true }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, supported);
});

test("unsupported service claims and evidence narration are removed without discarding a grounded partial answer", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const source = { document_id: "formation-doc", section_index: "1", chunk_id: "formation", chunk_index: 0,
    document_title: "Approved formation details", heading: "Formation steps",
    content: "The team prepares and submits company formation documents and follows up with the Companies Registry.", review_status: "approved" };
  const supported = "The team prepares and submits company formation documents and follows up with the Companies Registry.";
  const unsupportedService = "We provide ongoing accounting support.";
  const evidenceNarration = "The approved information confirms that.";
  const draft = `${supported} ${unsupportedService} ${evidenceNarration}`;
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "Summarize the relevant services.", locale: "english" }), {
    tools: { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "found", data: [source],
      modelObservation: buildApprovedKnowledgeObservation("found", [source]) }) } },
    decideNextStep: scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation" } },
      { type: "respond", text: draft }
    ]),
    assessDraft: async ({ text }) => text === draft
      ? { valid: false, reasons: ["service_not_established", "context_mismatch"], blockedClaims: [
        { sentence: unsupportedService, reasons: ["service_not_established"] },
        { sentence: evidenceNarration, reasons: ["context_mismatch"] }
      ] }
      : { valid: true }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, supported);
});

test("a two-search turn keeps one tool-free correction step after the second rejected draft", async () => {
  const { buildApprovedKnowledgeObservation } = require("./agentTools");
  const sources = [
    { document_id: "scope-doc", section_index: "1", chunk_id: "scope", chunk_index: 0,
      document_title: "Approved scope", heading: "Services", content: "Refalco Group offers company formation and accounting.", review_status: "approved" },
    { document_id: "continuity-doc", section_index: "1", chunk_id: "continuity", chunk_index: 0,
      document_title: "Approved continuity", heading: "After formation", content: "Refalco Group keeps the same company file open after formation.", review_status: "approved" }
  ];
  let searchCount = 0;
  let rejectionCount = 0;
  let finalStepTools = null;
  const draft1 = "Refalco Group offers company formation and accounting.";
  const draft2 = "Refalco Group keeps the same company file open after formation.";
  const finalDraft = "Refalco Group offers company formation and accounting, and keeps the same company file open after formation.";
  const result = await runAgentTurn(buildAgentContext({ currentMessage: "What support continues after formation?", locale: "english" }), {
    tools: { searchApprovedKnowledge: { run: async () => {
      const source = sources[searchCount++];
      return { ok: true, status: "found", data: [source], modelObservation: buildApprovedKnowledgeObservation("found", [source]) };
    } } },
    decideNextStep: async ({ step, tools, observations }) => {
      if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company scope" } };
      if (step === 2) return { type: "respond", text: draft1 };
      if (step === 3) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "ongoing support" } };
      if (step === 4) return { type: "respond", text: draft2 };
      finalStepTools = Object.keys(tools);
      assert.equal(step, 5);
      assert.equal(tools.searchApprovedKnowledge, undefined, "the recovery slot must not repeat retrieval");
      const feedback = observations.filter((item) => item?.tool === "responsePolicyCheck");
      assert.equal(feedback.length, 2, "the final decision must see both rejected drafts");
      assert.match(feedback.at(-1).result.reasonCode, /service_not_established/);
      return { type: "respond", text: finalDraft };
    },
    assessDraft: async ({ text }) => {
      if (text === finalDraft) return { valid: true };
      rejectionCount += 1;
      return { valid: false, reasons: ["service_not_established"], blockedClaims: [{ sentence: text, reasons: ["service_not_established"] }] };
    }
  });
  assert.equal(searchCount, 2);
  assert.equal(rejectionCount, 2);
  assert.deepEqual(finalStepTools, []);
  assert.equal(result.outcome, "responded");
  assert.equal(result.stepCount, 5);
  assert.equal(result.response, finalDraft);
});

test("validateDecision rejects an invented tool name", () => {
  const result = validateDecision({ type: "tool", tool: "deleteDatabase", args: {} }, { searchApprovedKnowledge: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_tool_requested");
});

test("validateDecision rejects non-object args", () => {
  const result = validateDecision({ type: "tool", tool: "x", args: "DROP TABLE users" }, { x: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_tool_args");
});

test("a zero-question respond decision is valid: the customer's request is already answered", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "The current published price for company formation is listed on our services page." }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.finished, true);
  assert.equal(result.outcome, "responded");
  assert.match(result.response, /published price/);
  assert.equal(result.stepCount, 1);
});

test("the pre-send gate rejects questions about already known customer facts and regenerates", async () => {
  const context = buildAgentContext({
    currentMessage: "Can you explain the next steps?",
    locale: "english",
    knownCustomerFacts: { countryOfResidence: "Jordan", investmentBudget: "EUR 250,000" }
  });
  const decide = scriptedDecider([
    { type: "clarify", text: "Which country do you live in?" },
    { type: "respond", text: "Let's continue with the next steps for your request." }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
  assert.equal(result.stepCount, 2);
  assert.equal(result.steps[0].result.reasonCode, "never_reask:countryOfResidence");
  assert.match(result.response, /next steps/i);
});

test("the pre-send gate catches natural business-activity repeats in all three supported languages", async () => {
  const cases = [
    { locale: "english", question: "What kind of work do you do?", next: "I have that noted. What would you like to know next?" },
    { locale: "arabic", question: "ما طبيعة عملك؟", next: "سجلت ذلك. ما الذي تريد معرفته الآن؟" },
    { locale: "greek", question: "Με τι ασχολείστε;", next: "Το έχω σημειώσει. Τι θα θέλατε να μάθετε τώρα;" }
  ];
  for (const item of cases) {
    const context = buildAgentContext({
      currentMessage: "Please continue helping me.",
      locale: item.locale,
      knownCustomerFacts: { businessActivity: { value: "software consultancy", normalizedValue: "software consultancy", provenance: "customer_message", confidence: 1 } }
    });
    const result = await runAgentTurn(context, {
      decideNextStep: scriptedDecider([
        { type: "clarify", text: item.question },
        { type: "respond", text: item.next }
      ]),
      tools: {}
    });
    assert.equal(result.outcome, "responded", item.locale);
    assert.equal(result.steps[0].result.reasonCode, "never_reask:businessActivity", item.locale);
    assert.equal(result.response, item.next, item.locale);
  }
});

test("the pre-send gate permits clarification when stored facts are inferred or conflict", async () => {
  const context = buildAgentContext({
    currentMessage: "Tell me what you have recorded.",
    locale: "english",
    knownCustomerFacts: {
      countryOfResidence: { value: "Jordan", provenance: "derived_from_customer_message", confidence: 0.99, inferred: true },
      investmentBudget: { value: "EUR 250,000", provenance: "customer_message", confidence: 0.95, correctionNeeded: true }
    }
  });
  const result = await runAgentTurn(context, {
    decideNextStep: scriptedDecider([{ type: "clarify", text: "Which country do you live in?" }]),
    tools: {}
  });
  assert.equal(result.outcome, "clarified");
  assert.match(result.response, /country/i);
});

test("a tool call is executed, observed, and the loop continues for a second decision", async () => {
  let searchArgs = null;
  const context = buildAgentContext({ currentMessage: "Which company services do you provide?", locale: "english" });
  const tools = {
    searchApprovedKnowledge: {
      run: async (args) => {
        searchArgs = args;
        return {
          ok: true,
          status: "found",
          data: [{ heading: "Company formation service", content: "Company formation is available in Cyprus." }],
          // REFAL-AGENT-028: the factual-grounding check reads ONLY
          // `modelObservation` (Ticket 027's bounded, approval-filtered
          // surface), never raw `data` — this stub must set it too, matching
          // the real searchApprovedKnowledge tool's shape, for the company
          // service claim below to be grounded.
          modelObservation: {
            type: "approved_knowledge",
            status: "found",
            evidence: [{ title: "Company formation service", section: null, content: "Company formation is available in Cyprus.", contentTruncated: false, sourceRef: null }],
            truncated: false
          }
        };
      }
    }
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation service" } },
    { type: "respond", text: "Company formation is available in Cyprus." }
  ]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools });
  assert.equal(result.outcome, "responded");
  assert.equal(result.toolsUsed.length, 1);
  assert.equal(result.toolsUsed[0], "searchApprovedKnowledge");
  assert.deepEqual(searchArgs, { query: "company formation service" });
  assert.equal(result.stepCount, 2);
});

test("a tool that throws produces a structured failed observation, not an uncaught exception", async () => {
  const tools = { searchApprovedKnowledge: { run: async () => { throw new Error("edge function unreachable"); } } };
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "x" } },
    { type: "respond", text: "I can't confirm that right now, but I can help with what I do know." }
  ]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools });
  assert.equal(result.steps[0].result.ok, false);
  assert.equal(result.steps[0].result.reasonCode, "TOOL_THREW");
  assert.equal(result.outcome, "responded");
});

test("the loop stops at the step budget instead of looping forever", async () => {
  const tools = { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "no_evidence", data: [] }) } };
  const decide = async () => ({ type: "tool", tool: "searchApprovedKnowledge", args: { query: "x" } });
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools, maxSteps: 3 });
  assert.equal(result.outcome, "max_steps_reached");
  assert.equal(result.stepCount, 3);
  assert.equal(typeof result.response, "string");
  assert.notEqual(result.response, "");
});

test("knowledge evidence stays within one cumulative prompt budget across search rounds", async () => {
  const makeRows = (prefix) => Array.from({ length: 8 }, (_, index) => ({
    document_id: `${prefix}-doc-${index}`, section_index: "0", chunk_index: 0,
    chunk_id: `${prefix}-chunk-${index}`, document_title: "Approved section", heading: `Section ${index}`,
    content: `${prefix} ${"approved source detail ".repeat(95)}`, review_status: "approved"
  }));
  let round = 0;
  let secondEvidenceChars = 0;
  const tools = { searchApprovedKnowledge: { run: async () => ({
    ok: true, status: "found", data: [],
    modelObservation: require("./agentTools").buildApprovedKnowledgeObservation("found", makeRows(`round-${++round}`))
  }) } };
  const result = await runAgentTurn(BASE_CONTEXT, {
    tools,
    decideNextStep: async ({ observations, step }) => {
      const evidence = observations.flatMap((item) => item?.result?.modelObservation?.evidence || []);
      const chars = evidence.reduce((total, item) => total + item.content.length + item.title.length + (item.section || "").length + 48, 0);
      assert.ok(chars <= 10000, `decision evidence exceeded budget: ${chars}`);
      if (step === 3) secondEvidenceChars = chars;
      if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "service overview" } };
      if (step === 2) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "more service information" } };
      return { type: "respond", text: "The approved information describes the service areas in the retrieved sections." };
    }
  });
  assert.equal(round, 2);
  assert.ok(secondEvidenceChars <= 10000);
  assert.equal(result.outcome, "responded");
});

test("unselected new candidates without retained evidence stop repeated searches and preserve the answer attempt", async () => {
  let calls = 0;
  const source = { document_id: "doc-1", section_index: "1", chunk_id: "chunk-1", chunk_index: 1,
    document_title: "Approved service overview", heading: "Services", content: "Company formation and accounting are supported services.", review_status: "approved" };
  const tools = { searchApprovedKnowledge: { run: async () => {
    calls += 1;
    const observation = require("./agentTools").buildApprovedKnowledgeObservation("found", [source]);
    if (calls === 2) observation.candidateEvidence.push({ sourceRef: "unselected-new-candidate", title: "Unrelated section",
      section: "Not selected", content: "unrelated ".repeat(1200), relevance: 1 });
    return { ok: true, status: "found", data: [source], modelObservation: observation };
  } } };
  let secondSearchProgress;
  let finalSearchAvailable;
  const result = await runAgentTurn(BASE_CONTEXT, { tools, maxSteps: 4, decideNextStep: async ({ step, tools: available, observations }) => {
    if (step === 1) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "service overview" } };
    if (step === 2) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company services" } };
    secondSearchProgress = observations[1]?.result?.reasonCode;
    finalSearchAvailable = Object.hasOwn(available, "searchApprovedKnowledge");
    return { type: "respond", text: "I can help with the details supported by approved information." };
  } });
  assert.equal(calls, 2);
  assert.equal(finalSearchAvailable, false);
  assert.equal(secondSearchProgress, "NO_NEW_RELEVANT_SECTIONS");
  assert.equal(result.steps[1].result.status, "no_new_evidence");
  assert.equal(result.outcome, "responded");
  assert.equal(result.stepCount, 3);
});

test("two focused knowledge searches exhaust retrieval and reserve the remaining steps for an answer", async () => {
  let calls = 0;
  const tools = { searchApprovedKnowledge: { run: async () => {
    calls += 1;
    const source = { document_id: `doc-${calls}`, section_index: 0, chunk_id: `chunk-${calls}`, chunk_index: 0,
      document_title: "Approved service information", heading: `Section ${calls}`,
      content: `Approved service detail ${calls}.`, review_status: "approved" };
    return { ok: true, status: "found", modelObservation: require("./agentTools").buildApprovedKnowledgeObservation("found", [source]) };
  } } };
  let searchWasAvailableAfterLimit = true;
  const result = await runAgentTurn(BASE_CONTEXT, { tools, maxSteps: 5, decideNextStep: async ({ step, tools: available }) => {
    if (step <= 3) {
      if (step === 3) searchWasAvailableAfterLimit = Object.hasOwn(available, "searchApprovedKnowledge");
      return { type: "tool", tool: "searchApprovedKnowledge", args: { query: `distinct approved detail ${step}` } };
    }
    return { type: "respond", text: "The approved information describes the supported service details." };
  } });
  assert.equal(calls, 2, "a bounded recovery search is allowed, then retrieval stops");
  assert.equal(searchWasAvailableAfterLimit, false);
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "The approved information describes the supported service details.");
});

test("one exhausted-search correction does not consume the reserved answer-review step", async () => {
  let calls = 0;
  let stepThreeCalls = 0;
  let answerStep = null;
  const tools = { searchApprovedKnowledge: { run: async () => {
    calls += 1;
    const source = { document_id: `doc-${calls}`, section_index: 0, chunk_id: `chunk-${calls}`, chunk_index: 0,
      document_title: "Approved service information", heading: `Section ${calls}`,
      content: `Approved service detail ${calls}.`, review_status: "approved" };
    return { ok: true, status: "found", modelObservation: require("./agentTools").buildApprovedKnowledgeObservation("found", [source]) };
  } } };
  const result = await runAgentTurn(BASE_CONTEXT, { tools, maxSteps: 5, decideNextStep: async ({ step }) => {
    if (step <= 2) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: `distinct approved detail ${step}` } };
    if (step === 3 && stepThreeCalls++ === 0) return { type: "tool", tool: "searchApprovedKnowledge", args: { query: "one more search after exhaustion" } };
    answerStep = step;
    return { type: "respond", text: "The approved information describes the supported service details." };
  } });
  assert.equal(calls, 2);
  assert.equal(stepThreeCalls, 1);
  assert.equal(answerStep, 4);
  assert.equal(result.outcome, "responded");
  assert.equal(result.stepCount, 4);
});

test("a decision naming an unknown tool stops safely with a deterministic fallback, not a thrown error", async () => {
  const decide = scriptedDecider([{ type: "tool", tool: "sendWireTransfer", args: {} }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 1 });
  assert.equal(result.outcome, "invalid_decision");
  assert.equal(result.reason, "unknown_tool_requested");
  assert.equal(typeof result.response, "string");
});

test("an invalid tool decision remains an invalid-decision fallback at the reserved final step", async () => {
  const result = await runAgentTurn(BASE_CONTEXT, {
    decideNextStep: scriptedDecider([{ type: "tool", tool: "sendWireTransfer", args: {} }]),
    tools: {}, maxSteps: 3
  });
  assert.equal(result.outcome, "invalid_decision");
  assert.equal(result.reason, "unknown_tool_requested");
  assert.equal(typeof result.response, "string");
});

test("an unknown tool request gets one bounded correction decision when steps remain", async () => {
  const calls = [];
  const result = await runAgentTurn(BASE_CONTEXT, { tools: {}, maxSteps: 3,
    decideNextStep: async ({ step, observations }) => {
      calls.push(step);
      if (step === 1) return { type: "tool", tool: "inventedTool", args: {} };
      assert.ok(observations.some((item) => item.tool === "decisionValidation" && item.result.reasonCode === "unknown_tool_requested"));
      return { type: "clarify", text: "Which part would you like to understand first?" };
    }
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.outcome, "clarified");
  assert.equal(result.response, "Which part would you like to understand first?");
});

test("a respond draft with too many questions is mechanically corrected to the first question, not discarded", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "What is your budget? And when do you want to start?" }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "What is your budget?");
  assert.equal(result.stepCount, 1);
});

test("format-only rejections are corrected and fully revalidated without a generation retry", async () => {
  const context = buildAgentContext({ currentMessage: "What benefits does setting up a company offer?", locale: "english" });
  const draft = "Thanks for the question. I can explain the relevant information. We can keep the answer focused. Tell me which part matters most?";
  let generationCalls = 0;
  let groundingReviews = 0;
  const result = await runAgentTurn(context, {
    decideNextStep: async () => { generationCalls += 1; return { type: "respond", text: draft }; },
    tools: {},
    assessDraft: async () => { groundingReviews += 1; return { valid: true, reasons: [] }; }
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(generationCalls, 1);
  assert.equal(groundingReviews, 1);
  assert.equal(result.stepCount, 1);
  assert.equal((result.steps || []).filter(step => step.tool === "responsePolicyCheck").length, 0);
  assert.equal(require("./responsePolicy").validateResponse(result.response,
    require("./responsePolicy").responseThresholdsForMessage(context.currentMessage)).valid, true);
});

test("a paraphrased draft with the same rejection and unchanged evidence stops after one recovery", async () => {
  const context = buildAgentContext({ currentMessage: "Can you summarize the relevant information?", locale: "english" });
  let generationCalls = 0;
  let groundingCalls = 0;
  const drafts = ["That earlier detail is confirmed for you.", "The earlier detail is definitely confirmed for your situation."];
  const result = await runAgentTurn(context, {
    maxSteps: 5,
    decideNextStep: async () => ({ type: "respond", text: drafts[generationCalls++] || drafts.at(-1) }),
    tools: {},
    assessDraft: async ({ text }) => {
      groundingCalls += 1;
      return { valid: false, reasons: ["context_mismatch"], blockedClaims: [{ sentence: text, reasons: ["context_mismatch"] }] };
    }
  });
  assert.equal(generationCalls, 2);
  assert.equal(groundingCalls, 2);
  assert.equal(result.outcome, "response_rejected");
  assert.equal(result.reason, "repeated_validation_rejection_without_evidence_progress");
});

test("an overlong unsupported price is not delivered through formatting recovery", async () => {
  const context = buildAgentContext({ currentMessage: "What is the company formation package price?", locale: "english" });
  const longDetail = `Additional context ${"that does not support the price claim ".repeat(18)}.`;
  const draft = `The company formation package costs EUR 999. ${longDetail} The remaining information can be reviewed separately.`;
  let calls = 0;
  const result = await runAgentTurn(context, {
    decideNextStep: async () => {
      calls += 1;
      return calls === 1
        ? { type: "respond", text: draft }
        : { type: "respond", text: "I can’t confirm the current package price from the information available here." };
    },
    tools: {}
  });
  assert.equal(result.outcome, "responded");
  assert.equal(calls, 2);
  assert.doesNotMatch(result.response, /EUR 999/u);
  assert.ok((result.steps || []).some(item => item.tool === "responsePolicyCheck"
    && /too_long/u.test(item.result.reasonCode)));
});

test("an overlong price-bearing draft is never shortened in a way that could drop its qualifier", async () => {
  const context = buildAgentContext({ currentMessage: "What is the package price?", locale: "english" });
  const draft = `The package costs EUR 999 excluding VAT. ${"Additional details are included here. ".repeat(24)}`;
  let calls = 0;
  const result = await runAgentTurn(context, {
    decideNextStep: async () => {
      calls += 1;
      return calls === 1
        ? { type: "respond", text: draft }
        : { type: "respond", text: "I can't confirm the current price here. Please ask the team to verify it." };
    },
    tools: {}
  });
  assert.equal(result.outcome, "responded");
  assert.equal(calls, 2);
  assert.doesNotMatch(result.response, /EUR 999/u);
});

test("a rejection that can't be mechanically corrected (e.g. too long) gets one retried decision instead of an immediate generic fallback", async () => {
  const overlong = `This is a single overlong sentence without any question mark that just keeps going on and on ${"and on ".repeat(110)}until it exceeds the character limit the deterministic response policy enforces.`;
  // REFAL-AGENT-028: this second draft is deliberately a claim-free
  // sentence (no price/numeric/brand claim) — this test has no tool call and
  // no evidence anywhere, so it is proving retry-after-too-long recovery,
  // not factual grounding; a price number here would now (correctly) be
  // rejected as unsupported, which is a different test's job.
  const decide = scriptedDecider([
    { type: "respond", text: overlong },
    { type: "respond", text: "I can help you get started with company formation whenever you're ready." }
  ]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, undefined);
  assert.equal(result.response, "I can help you get started with company formation whenever you're ready.");
  assert.equal(result.stepCount, 2);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, "responsePolicyCheck");
  assert.match(result.steps[0].result.reasonCode, /too_long/);
});

test("length rejection feedback gives the next draft the active sentence and character limits", async () => {
  const overlong = `This draft is too long and needs a focused correction ${"with extra material ".repeat(45)}.`;
  let correction = "";
  const result = await runAgentTurn(BASE_CONTEXT, {
    decideNextStep: async ({ step, observations }) => {
      if (step === 1) return { type: "respond", text: overlong };
      correction = observations.find((item) => item.tool === "responsePolicyCheck")?.result?.correction || "";
      return { type: "respond", text: "I can help with that. What is your main goal?" };
    },
    tools: {}
  });
  assert.equal(result.outcome, "responded");
  assert.match(correction, /within 5 sentences and 700 characters/u);
  assert.match(correction, /Preserve the direct answer, the customer's stated context, and distinct relevant evidence-backed details/u);
  assert.match(correction, /Remove preambles, source narration, repeated caveats, and unrelated detail before removing a relevant fact/u);
});

test("repeated unrepairable length failures receive only one model correction attempt", async () => {
  const overlong = (call) => `This friendly reply ${["amber", "blue", "copper", "green", "silver", "violet"][call - 1]} is too long for the response limit ${"and adds no useful detail ".repeat(40)}.`;
  let calls = 0;
  const result = await runAgentTurn(BASE_CONTEXT, {
    decideNextStep: async () => {
      calls += 1;
      return { type: "respond", text: overlong(calls) };
    },
    tools: {}
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /too_long/);
  assert.equal(result.stepCount, 2);
});

test("a rejection that never becomes compliant exhausts the step budget and falls back to the generic safe reply, not silence", async () => {
  const overlong = `This is a single overlong sentence without any question mark that just keeps going on and on ${"and on ".repeat(110)}until it exceeds the character limit the deterministic response policy enforces.`;
  const decide = async () => ({ type: "respond", text: overlong });
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 2 });
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /too_long/);
  assert.equal(result.stepCount, 2);
  assert.equal(typeof result.response, "string");
  assert.notEqual(result.response, "");
});

test("a clarify draft with too many questions is also mechanically corrected, not discarded", async () => {
  const decide = scriptedDecider([{ type: "clarify", text: "What activity will the company do? And where will it operate?" }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "clarified");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "What activity will the company do?");
});

test("a clarify decision allows a single short question with no minimum length", async () => {
  const decide = scriptedDecider([{ type: "clarify", text: "What will the company's main activity be?" }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "clarified");
  assert.equal(result.response, "What will the company's main activity be?");
});

test("the fallback response is localized to the conversation's locale", async () => {
  const arabicContext = buildAgentContext({ currentMessage: "ما سعر تأسيس شركة؟", locale: "arabic" });
  const decide = scriptedDecider([{ type: "tool", tool: "nope", args: {} }]);
  const result = await runAgentTurn(arabicContext, { decideNextStep: decide, tools: {} });
  assert.match(result.response, /[؀-ۿ]/);
});

test("a decision call that throws (e.g. provider outage) ends the turn safely instead of crashing it", async () => {
  const decide = async () => { throw new Error("OpenRouter HTTP 500"); };
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "decision_failed");
  assert.equal(typeof result.response, "string");
});

// --- REFAL-AGENT-026: language-equivalence gate on respond/clarify drafts ---
// Ports legacy ai.js's `answer.length > 8 && detectMessageLanguage(answer) !==
// language` check into the Agent path, gated by `context.locale` (trusted,
// caller-supplied — never the model's own output).

// Deliberately price/package/claim-free — these test ONLY the language gate,
// never the pre-existing groundingPolicy.js checks (028) or raw-URL-claim
// check, which fire independently of language and are covered by their own
// tests (groundingPolicy.test.js, agentFactualGrounding.test.js).
const EN_TEXT = "Thanks for reaching out about company formation in Cyprus. I can help you with the next steps whenever you are ready.";
const AR_TEXT = "شكراً لتواصلك بخصوص تأسيس الشركة في قبرص. يسعدني مساعدتك بالخطوات التالية متى ما كنت جاهزاً.";
const EL_TEXT = "Ευχαριστούμε που επικοινωνήσατε για τη σύσταση εταιρείας στην Κύπρο. Χαίρομαι να σας βοηθήσω με τα επόμενα βήματα όποτε είστε έτοιμοι.";

const EN_CONTEXT = buildAgentContext({ currentMessage: "I want to form a company", locale: "english" });
const AR_CONTEXT = buildAgentContext({ currentMessage: "بدي أسس شركة", locale: "arabic" });
const EL_CONTEXT = buildAgentContext({ currentMessage: "Θέλω να ιδρύσω εταιρεία", locale: "greek" });

test("EN expected + EN response: allowed", async () => {
  const decide = scriptedDecider([{ type: "respond", text: EN_TEXT }]);
  const result = await runAgentTurn(EN_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
});

test("AR expected + AR response: allowed", async () => {
  const decide = scriptedDecider([{ type: "respond", text: AR_TEXT }]);
  const result = await runAgentTurn(AR_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
});

test("EL expected + EL response: allowed", async () => {
  const decide = scriptedDecider([{ type: "respond", text: EL_TEXT }]);
  const result = await runAgentTurn(EL_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
});

test("explicit translation output language is accepted without changing the customer's conversation locale", async () => {
  const context = buildAgentContext({ currentMessage: "How would you translate ‘company formation’ into Greek?",
    locale: "english", responseType: "direct_answer" });
  const result = await runAgentTurn(context, {
    decideNextStep: scriptedDecider([{ type: "respond", text: "Σύσταση εταιρείας." }]),
    tools: {}, maxSteps: 1,
    assessDraft: async () => ({ valid: true, reasons: [], blockedClaims: [] })
  });
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "Σύσταση εταιρείας.");
});

test("EN expected + AR response: rejected (never delivered to a customer expecting English)", async () => {
  const decide = scriptedDecider([{ type: "respond", text: AR_TEXT }]);
  const result = await runAgentTurn(EN_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 1,
    assessDraft: async () => ({ valid: true, reasons: [], blockedClaims: [] }) });
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /language_mismatch/);
});

test("a mostly English reply with an Arabic honorific is rejected even when semantic grounding passes", async () => {
  const context = buildAgentContext({ currentMessage: "Hi again", locale: "english",
    contact: { name: "Χάσαν", nameSource: "customer_stated" } });
  const decide = scriptedDecider([{ type: "respond", text: "Good to hear from you again, أستاذ حسن. What would you like to look at today?" }]);
  const result = await runAgentTurn(context, { decideNextStep: decide, tools: {}, maxSteps: 1,
    assessDraft: async () => ({ valid: true, reasons: [], blockedClaims: [] }) });
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /language_mismatch/);
});

test("AR expected + EN response: rejected", async () => {
  const decide = scriptedDecider([{ type: "respond", text: EN_TEXT }]);
  const result = await runAgentTurn(AR_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 1 });
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /language_mismatch/);
});

test("EL expected + EN response: rejected", async () => {
  const decide = scriptedDecider([{ type: "respond", text: EN_TEXT }]);
  const result = await runAgentTurn(EL_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 1 });
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /language_mismatch/);
});

test("a clarify draft in the wrong language is rejected the same way a respond draft is", async () => {
  const decide = scriptedDecider([{ type: "clarify", text: "Which city would you like the company registered in?" }]);
  const result = await runAgentTurn(AR_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 1 });
  assert.equal(result.outcome, "clarify_rejected");
  assert.match(result.reason, /language_mismatch/);
});

test("Latin brand/product names (Refalco Group, OpenRouter) inside an Arabic reply never false-positive the language gate", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "إحنا الشركة (Refalco Group)، وبنستخدم OpenRouter لدعم بعض الأدوات الداخلية. يسعدني ساعدك بأي سؤال." }]);
  const result = await runAgentTurn(AR_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded", "an Arabic-dominant reply must not be rejected just for containing a Latin brand/product name");
});

test("a realistic URL (e.g. a booking link) embedded in an Arabic reply never flips the underlying language detector to English (src/language.js)", () => {
  // Isolated at the detector level (agentObservability.js's languageSignalsFrom,
  // reused — not duplicated — by the new gate) rather than through
  // runAgentTurn, so this proves the language signal itself regardless of
  // the separate, pre-existing raw-URL-claim policy (028) that would
  // otherwise reject any raw URL for an unrelated reason. A realistic
  // random-token URL (matching the project's own calendar-link shape) is
  // used rather than a long, word-filled URL path dominating a bare-minimum
  // Arabic prefix — the same shared risk (any URL has SOME Latin
  // characters) applies identically to legacy's own `detectMessageLanguage`
  // call in ai.js, not something new introduced here.
  const { languageSignalsFrom } = require("./agentObservability");
  const signal = languageSignalsFrom("arabic", "المزيد من التفاصيل متوفرة هون، فيك تزور الرابط: https://calendar.app.google/Ny3HQG1iwmF3T5s58");
  assert.equal(signal.languageMismatch, false);
});

test("a very short draft (<=8 chars, legacy's own exemption) is never rejected on language grounds alone", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "Yes." }]);
  const result = await runAgentTurn(AR_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.notEqual(result.outcome, "response_rejected");
});

test("an unknown/missing locale never gates on language — nothing trustworthy to compare against", async () => {
  const unknownContext = buildAgentContext({ currentMessage: "hello" });
  const decide = scriptedDecider([{ type: "respond", text: "مرحباً، كيف فيني ساعدك اليوم بخصوص خدمات الشركة؟" }]);
  const result = await runAgentTurn(unknownContext, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
});

test("a wrong-language draft recovers on retry via the existing re-decision mechanism, never a silent edit", async () => {
  const decide = scriptedDecider([
    { type: "respond", text: EN_TEXT }, // wrong language for AR_CONTEXT — rejected
    { type: "respond", text: AR_TEXT } // correct language — accepted
  ]);
  const result = await runAgentTurn(AR_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 4 });
  assert.equal(result.outcome, "responded");
  assert.equal(result.stepCount, 2);
  assert.equal(result.response, AR_TEXT);
  // The rejected first draft must be fed back as an observation (the
  // existing retry/re-decision mechanism), never silently discarded.
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, "responsePolicyCheck");
  assert.match(result.steps[0].result.reasonCode, /language_mismatch/);
});

test("a wrong-language draft that never corrects exhausts the step budget and falls back safely", async () => {
  const decide = async () => ({ type: "respond", text: EN_TEXT });
  const result = await runAgentTurn(AR_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 2 });
  assert.equal(result.outcome, "response_rejected");
  assert.match(result.reason, /language_mismatch/);
  assert.equal(result.stepCount, 2);
});

// --- M1 close: the Agent path must run the same output gates as legacy -----
//
// detectAntiPatterns, assertHumourCompliance and assertModelKnowledgeIsGeneral
// each had exactly ONE caller in the repo, src/ai.js. The Agent path does not
// traverse that file, so flipping REFAL_AGENT_LIVE_ENABLED silently dropped
// every M1 output guard while antiPatterns.test.js and humourEngine.test.js
// stayed green. These tests assert through runAgentTurn, the real entry point,
// not against the gate modules in isolation — asserting the component is what
// let this hide in the first place.

test("Agent path rejects a joke when a hard ban forced humour level 0", async () => {
  const context = buildAgentContext({
    currentMessage: "My father passed away last month, so I need to pause the setup.",
    locale: "english"
  });
  const joke = "I am sorry to hear that, haha just kidding, let me pull up your file now.";
  const result = await runAgentTurn(context, {
    decideNextStep: scriptedDecider([{ type: "respond", text: joke }]),
    tools: {}
  });
  assert.notEqual(result.response, joke, "a joke next to a bereavement reached the customer");
});

test("Agent path rejects an unrequested meeting push (AP-6)", async () => {
  const context = buildAgentContext({
    currentMessage: "What documents do I need for a Cyprus company?",
    locale: "english"
  });
  // Purely informational request, no tier, no signal: offering a meeting here
  // is MB-AP5/CX R-04, and the legacy path has always blocked it.
  const push = "You need a passport and proof of address. Shall I book you a call with an adviser this week?";
  const result = await runAgentTurn(context, {
    decideNextStep: scriptedDecider([{ type: "respond", text: push }]),
    tools: {}
  });
  assert.notEqual(result.response, push, "an unrequested meeting push reached the customer");
});

test("Agent path still passes a clean, compliant answer through untouched", async () => {
  // The gates must not become a blanket rejection: a correct answer has to
  // survive, or the Agent path fails closed on everything and the tests above
  // would pass for the wrong reason.
  const context = buildAgentContext({
    currentMessage: "Which cities do you have offices in?",
    locale: "english"
  });
  const clean = "We have offices in Limassol, Larnaca, Paphos and Nicosia.";
  const result = await runAgentTurn(context, {
    decideNextStep: scriptedDecider([{ type: "respond", text: clean }]),
    tools: {}
  });
  assert.equal(result.response, clean, "a clean compliant answer was rejected by the new gates");
});
