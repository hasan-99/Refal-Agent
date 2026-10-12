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
const { runAgentTurn, validateDecision, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { buildAgentContext } = require("./agentContext");

const BASE_CONTEXT = buildAgentContext({ currentMessage: "What is the price to create a Cyprus company?", locale: "english" });

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test("DEFAULT_MAX_STEPS is a small bounded number, never unlimited", () => {
  assert.equal(DEFAULT_MAX_STEPS, 5);
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
  const tools = {
    searchApprovedKnowledge: {
      run: async (args) => {
        searchArgs = args;
        return {
          ok: true,
          status: "found",
          data: [{ heading: "Company formation price", content: "EUR 1500" }],
          // REFAL-AGENT-028: the factual-grounding check reads ONLY
          // `modelObservation` (Ticket 027's bounded, approval-filtered
          // surface), never raw `data` — this stub must set it too, matching
          // the real searchApprovedKnowledge tool's shape, for the "EUR
          // 1500" respond text below to be grounded.
          modelObservation: {
            type: "approved_knowledge",
            status: "found",
            evidence: [{ title: "Company formation price", section: null, content: "EUR 1500", contentTruncated: false, sourceRef: null }],
            truncated: false
          }
        };
      }
    }
  };
  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation price" } },
    { type: "respond", text: "Company formation is published at EUR 1500." }
  ]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools });
  assert.equal(result.outcome, "responded");
  assert.equal(result.toolsUsed.length, 1);
  assert.equal(result.toolsUsed[0], "searchApprovedKnowledge");
  assert.deepEqual(searchArgs, { query: "company formation price" });
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

test("a decision naming an unknown tool stops safely with a deterministic fallback, not a thrown error", async () => {
  const decide = scriptedDecider([{ type: "tool", tool: "sendWireTransfer", args: {} }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "invalid_decision");
  assert.equal(result.reason, "unknown_tool_requested");
  assert.equal(typeof result.response, "string");
});

test("a respond draft with too many questions is mechanically corrected to the first question, not discarded", async () => {
  const decide = scriptedDecider([{ type: "respond", text: "What is your budget? And when do you want to start?" }]);
  const result = await runAgentTurn(BASE_CONTEXT, { decideNextStep: decide, tools: {} });
  assert.equal(result.outcome, "responded");
  assert.equal(result.corrected, true);
  assert.equal(result.response, "What is your budget?");
  assert.equal(result.stepCount, 1);
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

test("EN expected + AR response: rejected (never delivered to a customer expecting English)", async () => {
  const decide = scriptedDecider([{ type: "respond", text: AR_TEXT }]);
  const result = await runAgentTurn(EN_CONTEXT, { decideNextStep: decide, tools: {}, maxSteps: 1 });
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
