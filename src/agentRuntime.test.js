const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurnForContact, buildToolContext } = require("./agentRuntime");
const { decideNextStep: defaultDecideNextStep } = require("./agentDecision");
const { INTENTS } = require("./intent");
const { MAX_RAG_EVIDENCE_ITEMS, MAX_RAG_EVIDENCE_TOTAL_CHARS } = require("./agentTools");
const { formatApprovedKnowledgeEvidence } = require("./agentDecision");

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test("buildToolContext binds the real embedText/embeddingModel defaults when the caller doesn't override them", () => {
  const ctx = buildToolContext({ store: {}, user: {}, userId: "u1" });
  assert.equal(typeof ctx.embedText, "function");
  assert.equal(typeof ctx.embeddingModel, "string");
  assert.equal(ctx.matchCount, 8);
});

test("buildToolContext passes trusted M4 contact, source-turn, consent, language, and capability context", () => {
  const ctx = buildToolContext({
    store: {}, user: {}, userId: "contact-1", inboundMessageId: "wa-provider-turn-9", sourceTurnId: "persisted-turn-uuid",
    language: "arabic", consentState: "granted", allowedCapabilities: ["upsertLead", "scheduleFollowUp"]
  });
  assert.equal(ctx.sourceTurnId, "persisted-turn-uuid");
  assert.equal(ctx.inboundMessageId, "wa-provider-turn-9");
  assert.equal(ctx.userId, "contact-1");
  assert.equal(ctx.consentState, "granted");
  assert.equal(ctx.language, "arabic");
  assert.deepEqual(ctx.allowedCapabilities, ["upsertLead", "scheduleFollowUp"]);
  assert.equal(Object.isFrozen(ctx.allowedCapabilities), true);
});

test("RAG is never invoked when the Agent's decision never asks for it (e.g. a simple acknowledgement)", async () => {
  let searchCalls = 0;
  const store = { searchKnowledge: async () => { searchCalls += 1; return []; } };
  const decide = scriptedDecider([{ type: "respond", text: "You're welcome, happy to help anytime." }]);

  const result = await runAgentTurnForContact(
    { currentMessage: "thank you", locale: "english", store, user: { id: "u1" }, userId: "u1" },
    { decideNextStep: decide }
  );

  assert.equal(result.outcome, "responded");
  assert.equal(searchCalls, 0, "a plain acknowledgement must never trigger a knowledge search");
});

test("runtime forwards latency-only telemetry for the default Agent model decision", async (t) => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalApiKey;
  });
  let metric;
  await runAgentTurnForContact({
    currentMessage: "thank you",
    locale: "english",
    store: {},
    user: {},
    userId: "test-contact"
  }, {
    decideNextStep: defaultDecideNextStep,
    onModelCall: (value) => { metric = value; }
  });
  assert.ok(Number.isSafeInteger(metric.durationMs));
  assert.ok(metric.durationMs >= 0);
  assert.deepEqual(Object.keys(metric), ["durationMs"]);
});

test("buildToolContext supplies the trusted current message for CRM statement verification", () => {
  const ctx = buildToolContext({ store: {}, user: {}, userId: "contact-1", currentMessage: "I live in Jordan.", sourceTurnId: "turn-1" });
  assert.equal(ctx.currentMessage, "I live in Jordan.");
  assert.equal(ctx.sourceTurnId, "turn-1");
});

test("broad services intents retrieve overview, scope, and current-conditions evidence before the model decides", async () => {
  let searchCalls = 0;
  const queries = [];
  let observationsSeenByModel = null;
  const store = {
    searchKnowledge: async (query) => {
      searchCalls += 1;
      queries.push(query);
      if (searchCalls === 1) {
        assert.match(query, /company formation and structuring/);
        assert.match(query, /intellectual property and GDPR/);
        assert.match(query, /real estate and property development/u);
      }
      if (searchCalls === 2) assert.match(query, /business tax and operations/);
      if (searchCalls === 3) assert.match(query, /company banking and payment gateways/);
      if (searchCalls === 4) assert.match(query, /residency and relocation/);
      if (searchCalls === 5) assert.match(query, /property purchase/);
      if (searchCalls === 6) assert.match(query, /landowners, development and construction/);
      if (searchCalls === 7) assert.match(query, /Jurisdiction comparison/);
      if (searchCalls === 8) assert.match(query, /Refalco Group company profile/);
      return [{ heading: "Company formation", content: "We provide company formation support." }];
    }
  };
  const decide = async ({ observations }) => {
    observationsSeenByModel = observations;
    return { type: "respond", text: "We provide company formation support." };
  };

  const result = await runAgentTurnForContact({
    currentMessage: "What services do you offer?",
    locale: "english",
    store,
    user: { id: "u1" },
    userId: "u1",
    intents: [INTENTS.SERVICES],
    embedText: async () => [1]
  }, { decideNextStep: decide });

    assert.equal(searchCalls, 8);
    assert.match(queries[0], /^What services do you offer\?/);
    assert.ok(queries.slice(1).every((query) => !query.includes("What services do you offer?")),
      "focused facet searches must not be diluted by the broad customer wording");
  assert.equal(observationsSeenByModel.length, 1, "broad retrieval is merged into one bounded model-visible evidence set");
  assert.equal(observationsSeenByModel[0].tool, "searchApprovedKnowledge");
  assert.equal(observationsSeenByModel[0].result.modelObservation.status, "found");
  assert.equal(result.outcome, "responded");
  assert.equal(result.response, "We provide company formation support. Which area would you like to hear more about?");
  assert.deepEqual(result.toolsUsed, ["searchApprovedKnowledge"]);
});

test("broad retrieval gives the model a deduplicated, facet-balanced set within the evidence budget", async () => {
  let searchCalls = 0;
  let initial = null;
  const makeRow = (id, heading) => ({ document_title: `Topic ${heading}`, heading, content: `${heading} ${"evidence ".repeat(90)}`,
    chunk_id: id, review_status: "approved" });
  const store = { searchKnowledge: async () => {
    const index = searchCalls++;
    if (index === 0) return [makeRow("shared", "Shared result"), makeRow("a2", "Facet A second result")];
    if (index === 1) return [makeRow("shared", "Shared result"), makeRow("b2", "Facet B second result")];
    return [makeRow(`facet-${index}`, `Facet ${index} first result`), makeRow(`facet-${index}-2`, `Facet ${index} second result`)];
  } };
  const result = await runAgentTurnForContact({
    currentMessage: "What services do you offer?", locale: "english", store, user: { id: "u1" }, userId: "u1",
    intents: [INTENTS.SERVICES], embedText: async () => [1]
  }, { decideNextStep: async ({ observations }) => {
    initial = observations;
    return { type: "respond", text: "I can outline the relevant areas. Which one matters most to you?" };
  } });

  assert.equal(searchCalls, 8);
  assert.equal(initial.length, 1);
  const merged = initial[0].result.modelObservation;
  assert.equal(merged.evidence.length, MAX_RAG_EVIDENCE_ITEMS);
  assert.equal(new Set(merged.evidence.map((item) => item.sourceRef)).size, merged.evidence.length);
  assert.deepEqual(merged.evidence.map((item) => item.section), [
    "Shared result", "Facet 2 first result", "Facet 3 first result", "Facet 4 first result",
    "Facet 5 first result", "Facet 6 first result", "Facet 7 first result", "Facet A second result"
  ]);
  const evidenceChars = merged.evidence.reduce((sum, item) => sum + item.title.length + item.section.length + item.content.length, 0);
  assert.ok(evidenceChars <= MAX_RAG_EVIDENCE_TOTAL_CHARS);
  assert.ok(formatApprovedKnowledgeEvidence(merged).length <= MAX_RAG_EVIDENCE_TOTAL_CHARS,
    "the exact prompt rendering, including source references and labels, stays within the budget");
  assert.equal(merged.truncated, true);
  assert.equal(result.outcome, "responded");
});

test("broad retrieval fails closed when any service facet search fails", async () => {
  let calls = 0;
  let decisionCalls = 0;
  const result = await runAgentTurnForContact({
    currentMessage: "What services do you offer?", locale: "english", store: {
      searchKnowledge: async () => {
        calls += 1;
        if (calls === 4) throw new Error("facet unavailable");
        return [{ heading: `Facet ${calls}`, content: "This partial evidence must not be presented as complete." }];
      }
    }, user: { id: "u1" }, userId: "u1", intents: [INTENTS.SERVICES], embedText: async () => [1]
  }, { decideNextStep: async () => {
    decisionCalls += 1;
    return { type: "respond", text: "Unsupported scripted model text." };
  } });

  assert.equal(calls, 8);
  assert.equal(decisionCalls, 0, "the model must not draft from an incomplete broad search");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].result.ok, false);
  assert.equal(result.steps[0].result.status, "error");
  assert.equal(result.steps[0].result.partialRetrievalFailures, 1);
  assert.equal(result.steps[0].result.modelObservation.partialRetrievalFailures, 1);
  assert.deepEqual(result.steps[0].result.data, []);
  assert.deepEqual(result.steps[0].result.modelObservation.evidence, []);
  assert.equal(result.outcome, "responded");
  assert.match(result.response, /approved information/u);
  assert.doesNotMatch(result.response, /Unsupported scripted model text/u);
  assert.equal(result.reasonCode, "INCOMPLETE_BROAD_KNOWLEDGE_RETRIEVAL");
});

test("broad Arabic and Greek service searches keep one customer-anchored query and localize focused facets", async () => {
  const samples = [
    { locale: "arabic", text: "شو خدماتكم؟", facets: [
      /تأسيس الشركات في قبرص/u, /ضرائب الشركات والعمليات في قبرص/u, /الخدمات المصرفية/u, /الإقامة والانتقال إلى قبرص/u,
      /شراء العقارات في قبرص/u, /ملاك الأراضي والتطوير والبناء/u, /مقارنة الولايات القضائية/u, /نبذة وهوية مجموعة Refalco/u
    ], english: /Cyprus business tax and operations/u },
    { locale: "greek", text: "Τι υπηρεσίες προσφέρετε;", facets: [
      /Σύσταση εταιρείας στην Κύπρο/u, /Φορολογία επιχειρήσεων και λειτουργία/u, /Τραπεζικές υπηρεσίες/u, /Διαμονή και μετεγκατάσταση στην Κύπρο/u,
      /Αγορά ακινήτου στην Κύπρο/u, /Ιδιοκτήτες γης, ανάπτυξη και κατασκευές/u, /Σύγκριση δικαιοδοσιών/u, /Προφίλ, ταυτότητα και εγκεκριμένο ιστορικό/u
    ], english: /Cyprus business tax and operations/u }
  ];
  for (const sample of samples) {
    const queries = [];
    let activeSearches = 0;
    let maxActiveSearches = 0;
    await runAgentTurnForContact({
      currentMessage: sample.text, locale: sample.locale, language: sample.locale,
      store: { searchKnowledge: async (query) => {
        activeSearches += 1;
        maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
        queries.push(query);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeSearches -= 1;
        return [{ heading: "Approved area", content: "Approved service information." }];
      } },
      user: { id: `u-${sample.locale}` }, userId: `u-${sample.locale}`, intents: [INTENTS.SERVICES], embedText: async () => [1]
    }, { decideNextStep: async () => ({ type: "respond", text: "I can explain the main service areas." }) });
    assert.equal(queries.length, 8);
    assert.equal(maxActiveSearches, 8, "independent service facets run concurrently to reduce response latency");
    assert.ok(queries[0].startsWith(sample.text), "the lead query preserves the customer's exact wording");
    assert.ok(queries.slice(1).every((query) => !query.includes(sample.text)), "focused facets avoid repeated broad wording");
    for (const [index, facet] of sample.facets.entries()) assert.match(queries[index], facet, `localized facet ${index + 1} stays in its deliberate position`);
    assert.doesNotMatch(queries.join(" "), sample.english, "Arabic and Greek broad retrieval must not fall back to English-only service facets");
  }
});

test("multi-topic broad requests preserve the full question while each parallel query stays focused", async () => {
  const samples = [
    { locale: "english", text: "Do you help with company tax, business bank accounts, residency, and property?" },
    { locale: "arabic", text: "هل تساعدون في ضريبة الشركات والحسابات البنكية والإقامة والعقارات؟" },
    { locale: "greek", text: "Βοηθάτε με εταιρικούς φόρους, τραπεζικούς λογαριασμούς, διαμονή και ακίνητα;" }
  ];
  for (const sample of samples) {
    const queries = [];
    await runAgentTurnForContact({
      currentMessage: sample.text, locale: sample.locale, language: sample.locale,
      store: { searchKnowledge: async (query) => {
        queries.push(query);
        return [{ heading: "Approved area", content: "Approved service information." }];
      } },
      user: { id: `multi-${sample.locale}` }, userId: `multi-${sample.locale}`,
      intents: [INTENTS.SERVICES], embedText: async () => [1]
    }, { decideNextStep: async () => ({ type: "respond", text: "I can outline the approved areas." }) });

    assert.equal(queries.length, 8);
    assert.ok(queries[0].includes(sample.text), "the full multi-topic customer question remains represented");
    assert.ok(queries.slice(1).every((query) => !query.includes(sample.text)), "each remaining query targets one localized facet");
    assert.ok(queries[0].length < 1000, "the bounded lead query preserves the multi-topic customer question");
    assert.ok(queries.slice(1).every((query) => query.length < 400), "focused facet queries retain useful terms without oversized mixed-domain prompts");
  }
});

test("broad retrieval enforces the total prompt evidence character budget", async () => {
  let index = 0;
  let merged = null;
  const store = { searchKnowledge: async () => [{ document_title: `Topic ${index}`, heading: `Facet ${index++}`,
    content: "x".repeat(1900), chunk_id: `large-${index}`, review_status: "approved" }] };
  await runAgentTurnForContact({
    currentMessage: "What services do you offer?", locale: "english", store, user: { id: "u1" }, userId: "u1",
    intents: [INTENTS.SERVICES], embedText: async () => [1]
  }, { decideNextStep: async ({ observations }) => {
    merged = observations[0].result.modelObservation;
    return { type: "respond", text: "I can outline the relevant areas. Which one matters most to you?" };
  } });
  assert.ok(merged.evidence.length <= MAX_RAG_EVIDENCE_ITEMS);
  assert.ok(merged.evidence.length > 0);
  const chars = merged.evidence.reduce((sum, item) => sum + item.title.length + item.section.length + item.content.length, 0);
  assert.ok(chars <= MAX_RAG_EVIDENCE_TOTAL_CHARS);
  assert.equal(merged.truncated, true);
  assert.ok(merged.evidence.some((item) => item.contentTruncated) || merged.evidence.length < MAX_RAG_EVIDENCE_ITEMS);
  assert.ok(formatApprovedKnowledgeEvidence(merged).length <= MAX_RAG_EVIDENCE_TOTAL_CHARS);
});

test("broad Arabic service answers get one neutral next question, while focused requests keep their answer", async () => {
  const { appendBroadServiceFollowup } = require("./agentRuntime");
  const broad = appendBroadServiceFollowup(
    { outcome: "responded", response: "خدماتنا تشمل تأسيس الشركات والعقار." },
    { intents: [INTENTS.SERVICES], locale: "arabic", currentMessage: "شو هي خدماتكم؟" }
  );
  assert.equal(broad.response, "خدماتنا تشمل تأسيس الشركات والعقار. أي مجال حابب تعرف عنه أكثر؟");
  const alreadyInteractive = appendBroadServiceFollowup(
    { outcome: "responded", response: "خدماتنا تشمل تأسيس الشركات. أي مجال يهمك؟" },
    { intents: [INTENTS.SERVICES], locale: "arabic", currentMessage: "شو هي خدماتكم؟" }
  );
  assert.equal(alreadyInteractive.response, "خدماتنا تشمل تأسيس الشركات. أي مجال يهمك؟");
  const focused = appendBroadServiceFollowup(
    { outcome: "responded", response: "Company formation is one of our services." },
    { intents: [INTENTS.SERVICES, INTENTS.COMPANY_FORMATION], locale: "english", currentMessage: "Do you offer company formation?" }
  );
  assert.equal(focused.response, "Company formation is one of our services.");
});

test("broad service follow-up is not repeated when it was already asked recently", () => {
  const { appendBroadServiceFollowup } = require("./agentRuntime");
  const priorFollowup = "Which area would you like to hear more about?";
  const result = appendBroadServiceFollowup(
    { outcome: "responded", response: "We support several business areas." },
    {
      intents: [INTENTS.SERVICES], locale: "english", currentMessage: "What else do you do?",
      recentConversation: [
        { role: "assistant", content: `Earlier answer. ${priorFollowup}` },
        { role: "user", content: "Can you explain more?" }
      ]
    }
  );
  assert.equal(result.response, "We support several business areas.");
});

test("an ambiguous follow-up searches using recent conversation context without canned query terms", async () => {
  let searchedQuery = "";
  const store = {
    searchKnowledge: async (query) => {
      searchedQuery = query;
      return [{
        heading: "بداية التأسيس",
        content: "للبدء، نحدد نشاط الشركة ونحجز الاسم، ثم نجهز مستندات التأسيس ونقدمها لسجل الشركات."
      }];
    }
  };
  const result = await runAgentTurnForContact({
    currentMessage: "طيب كيف فينا نبلش",
    locale: "arabic",
    store,
    user: { id: "u1" },
    userId: "u1",
    intents: [INTENTS.UNKNOWN],
    recentConversation: [
      { role: "user", content: "انا بدي اسجل شركة بقبرص" },
      { role: "assistant", content: "أكيد، فينا نساعدك بتأسيس شركة بقبرص. عادةً بتمر العملية بتحديد نشاط الشركة، حجز الاسم، وتجهيز وتقديم مستندات التأسيس لسجل الشركات." }
    ],
    embedText: async () => [1]
  }, {
    decideNextStep: async ({ observations }) => {
      assert.equal(observations[0].tool, "searchApprovedKnowledge");
      return {
        type: "respond",
        text: "للبدء، نحدد نشاط الشركة ونحجز الاسم، ثم نجهز مستندات التأسيس ونقدمها لسجل الشركات."
      };
    }
  });

  assert.match(searchedQuery, /انا بدي اسجل شركة بقبرص/u);
  assert.match(searchedQuery, /طيب كيف فينا نبلش/u);
  assert.match(searchedQuery, /حجز الاسم/u);
  assert.doesNotMatch(searchedQuery, /Cyprus company formation incorporation first steps name reservation/i);
  assert.equal(result.outcome, "responded");
  assert.match(result.response, /نحجز الاسم/u);
});

test("direct factual follow-ups preserve the prior topic in English, Arabic, and Greek RAG searches", async () => {
  const cases = [
    { current: "And what about the price?", prior: "What services does your Cyprus company formation package include?", language: "english", answer: "I don't have an approved price to share yet." },
    { current: "How much?", prior: "What services does your Cyprus company formation package include?", language: "english", answer: "I don't have an approved price to share yet." },
    { current: "And price?", prior: "What services does your Cyprus company formation package include?", language: "english", answer: "I don't have an approved price to share yet." },
    { current: "How long?", prior: "What services does your Cyprus company formation package include?", language: "english", answer: "I don't have an approved price to share yet." },
    { current: "طيب قديش السعر؟", prior: "شو بتشمل باقة تأسيس شركة بقبرص؟", language: "arabic", answer: "ما عندي سعر معتمد حالياً." },
    { current: "شو السعر؟", prior: "شو بتشمل باقة تأسيس شركة بقبرص؟", language: "arabic", answer: "ما عندي سعر معتمد حالياً." },
    { current: "Και πόσο κοστίζει;", prior: "Τι περιλαμβάνει το πακέτο σύστασης εταιρείας στην Κύπρο;", language: "greek", answer: "Δεν έχω εγκεκριμένη τιμή αυτή τη στιγμή." },
    { current: "Και η τιμή;", prior: "Τι περιλαμβάνει το πακέτο σύστασης εταιρείας στην Κύπρο;", language: "greek", answer: "Δεν έχω εγκεκριμένη τιμή αυτή τη στιγμή." },
    { current: "Kai i timi?", prior: "Τι περιλαμβάνει το πακέτο σύστασης εταιρείας στην Κύπρο;", language: "greek", answer: "Δεν έχω εγκεκριμένη τιμή αυτή τη στιγμή." }
  ];
  for (const item of cases) {
    let searchedQuery = "";
    const result = await runAgentTurnForContact({
      currentMessage: item.current,
      locale: item.language,
      store: { searchKnowledge: async (query) => { searchedQuery = query; return []; } },
      user: { id: "u1" },
      userId: "u1",
      intents: [INTENTS.PRICING],
      recentConversation: [{ role: "user", content: item.prior }],
      embedText: async () => null
    }, { decideNextStep: async () => ({ type: "respond", text: item.answer }) });
    assert.equal(result.outcome, "responded");
    assert.ok(searchedQuery.includes(item.prior), `prior topic missing for ${item.language}: ${searchedQuery}`);
    assert.ok(searchedQuery.includes(item.current), `current follow-up missing for ${item.language}: ${searchedQuery}`);
    const knowledgeStep = result.steps.find((step) => step.tool === "searchApprovedKnowledge");
    assert.deepEqual(knowledgeStep.result.modelObservation.evidence, [], "conversation context is search input, never approved evidence");
  }
});

test("standalone factual questions do not inherit unrelated recent conversation in RAG searches", async () => {
  for (const currentMessage of ["What is the company formation price in Cyprus?", "How much?"]) {
    let searchedQuery = "";
    const result = await runAgentTurnForContact({
      currentMessage,
      locale: "english",
      store: { searchKnowledge: async (query) => { searchedQuery = query; return []; } },
      user: { id: "u1" },
      userId: "u1",
      intents: [INTENTS.PRICING],
      recentConversation: [{ role: "user", content: "Who won the football match yesterday?" }],
      embedText: async () => null
    }, { decideNextStep: async () => ({ type: "respond", text: "I don't have an approved price to share yet." }) });
    assert.equal(result.outcome, "responded");
    assert.equal(searchedQuery, currentMessage);
  }
});

test("a real end-to-end turn: decide calls searchApprovedKnowledge, the real tool reaches the injected embedText and store, and the answer is grounded in the returned evidence", async () => {
  let searchArgs = null;
  const store = {
    searchKnowledge: async (query, embedding, embeddingModel, matchCount) => {
      searchArgs = { query, embedding, embeddingModel, matchCount };
      return [{ heading: "Company formation price", content: "The published company formation price is EUR 1500." }];
    }
  };
  const fakeEmbedText = async (text) => [text.length]; // deterministic stand-in, no real transformer pipeline in a unit test

  const decide = scriptedDecider([
    { type: "tool", tool: "searchApprovedKnowledge", args: { query: "company formation price" } },
    { type: "respond", text: "The published company formation price is EUR 1500." }
  ]);

  const result = await runAgentTurnForContact(
    {
      currentMessage: "What is the price to create a Cyprus company?",
      locale: "english",
      store,
      user: { id: "u1" },
      userId: "u1",
      embedText: fakeEmbedText,
      embeddingModel: "test-model"
    },
    { decideNextStep: decide }
  );

  assert.equal(result.outcome, "responded");
  assert.match(result.response, /EUR 1500/);
  assert.equal(result.toolsUsed[0], "searchApprovedKnowledge");
  assert.deepEqual(searchArgs.embedding, [String("company formation price").length]);
  assert.equal(searchArgs.embeddingModel, "test-model");
  assert.equal(searchArgs.matchCount, 20, "the search adapter retrieves a bounded overfetch window before governance filtering");
});

test("a knowledge-search failure cannot make a prior assistant company-fact answer valid evidence", async () => {
  const store = { searchKnowledge: async () => { throw new Error("edge function unreachable"); } };
  const decide = scriptedDecider([
    { type: "respond", text: "The package costs EUR 1,500." },
    { type: "respond", text: "I can't confirm the current price right now, but I can help with anything else." }
  ]);

  const result = await runAgentTurnForContact(
    {
      currentMessage: "Is that still the current price?", locale: "english", store, user: { id: "u1" }, userId: "u1", embedText: async () => null,
      recentConversation: [
        { role: "user", content: "What does company formation cost?" },
        { role: "assistant", content: "The package costs EUR 1,500." }
      ]
    },
    { decideNextStep: decide }
  );

  assert.equal(result.outcome, "responded");
  assert.doesNotMatch(result.response, /1,500/);
  assert.match(result.response, /can't confirm/i);
  assert.ok(result.steps.some((step) => step.result?.reasonCode === "RETRIEVAL_FAILED"));
  assert.ok(result.steps.some((step) => String(step.result?.reasonCode || "").includes("unsupported_")));
});

test("formation package price questions deterministically prefetch the approved offer before the model in EN, AR, and EL", async () => {
  const samples = [
    { locale: "english", currentMessage: "What is the price of your company formation package?" },
    { locale: "arabic", currentMessage: "كم سعر باقة تأسيس الشركة؟" },
    { locale: "greek", currentMessage: "Ποια είναι η τιμή του πακέτου σύστασης εταιρείας;" }
  ];
  for (const sample of samples) {
    let lookupCalls = 0;
    let initial;
    await runAgentTurnForContact({
      ...sample, store: {}, user: { id: `offer-${sample.locale}` }, userId: `offer-${sample.locale}`,
      recentConversation: [], intents: []
    }, {
      tools: { lookupActiveOffer: { run: async (args) => {
        lookupCalls += 1;
        assert.deepEqual(args, { code: "formation-package" });
        return { ok: true, status: "found", modelObservation: { type: "dynamic_data", source: "trusted_edge_dynamic_read", kind: "offers", status: "found", records: [{ code: args.code, reviewStatus: "approved", active: true, price: "approved value" }] } };
      } } },
      decideNextStep: async ({ observations }) => {
        initial = observations;
        return { type: "respond", text: "I can check the approved package details." };
      }
    });
    assert.equal(lookupCalls, 1, sample.locale);
    assert.equal(initial[0].tool, "lookupActiveOffer", sample.locale);
    assert.equal(initial[0].result.modelObservation.records[0].price, "approved value", sample.locale);
  }
});

test("formation package price follow-ups use prior customer topic while ignoring assistant-only context", async () => {
  const lookup = { run: async () => ({ ok: true, status: "found", modelObservation: { type: "dynamic_data", records: [] } }) };
  let lookups = 0;
  const countingLookup = { run: async (...args) => { lookups += 1; return lookup.run(...args); } };
  const run = (recentConversation) => runAgentTurnForContact({
    currentMessage: "How much does it cost?", locale: "english", store: {}, user: { id: "follow-up" }, userId: "follow-up", recentConversation
  }, { tools: { lookupActiveOffer: countingLookup }, decideNextStep: async () => ({ type: "respond", text: "I can check that for you." }) });
  await run([{ role: "user", content: "I'm looking at company formation." }]);
  assert.equal(lookups, 1);
  await run([{ role: "assistant", content: "The formation package costs €500." }]);
  assert.equal(lookups, 1, "assistant-only historical mentions cannot trigger an offer lookup");
});
