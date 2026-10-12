"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assessAgentDraft, validateGroundingVerdict, reviewIdentity } = require("./semanticGrounding");
const { runAgentTurnForContact } = require("./agentRuntime");
const { buildDecisionMessages } = require("./agentDecision");
const { buildGroundingReviewMessages } = require("./semanticGrounding");
test("request coverage accepts evidenced partial answers and identifies actual unanswered aspects", () => {
  const request = "What support and timing are confirmed?";
  const text = "Approved support is available; timing is unconfirmed in the supplied evidence.";
  const base = {segments:[{text,status:"supported",evidenceRefs:["scope"],reasonCode:"supported"}],languageValid:true,contextValid:true,contextIssues:[]};
  const partial = validateGroundingVerdict({...base,requestCoverage:{outcome:"supported_partial",unmetAspects:[]}},text,[{sourceRef:"scope"}],request);
  assert.equal(partial.valid,true);
  const missed = validateGroundingVerdict({...base,requestCoverage:{outcome:"not_addressed",unmetAspects:["timing"]}},text,[{sourceRef:"scope"}],request);
  assert.equal(missed.valid,false);
  assert.deepEqual(missed.blockedClaims,[{sentence:"timing",claimClass:"UNMET_REQUEST",reasons:["question_not_answered"]}]);
  for (const unmetAspects of [[],["book an appointment"]]) {
    const invalid=validateGroundingVerdict({...base,requestCoverage:{outcome:"not_addressed",unmetAspects}},text,[{sourceRef:"scope"}],request);
    assert.equal(invalid.technicalFailure,true);
    assert.equal(invalid.errorCode,"GROUNDING_VERDICT_SHAPE_INVALID");
  }
});
test("reviewer output defects have distinct safe diagnostics and never approve omitted claims", () => {
  assert.equal(validateGroundingVerdict(null, "Answer").errorCode, "GROUNDING_VERDICT_SHAPE_INVALID");
  const missing = { segments:[{text:"Hello.",status:"non_factual",evidenceRefs:[],reasonCode:"non_factual"}],languageValid:true,contextValid:true,contextIssues:[],requestCoverage:{outcome:"addressed",unmetAspects:[]} };
  const result = validateGroundingVerdict(missing, "Hello. Approval is guaranteed.");
  assert.equal(result.valid,false);
  assert.equal(result.technicalFailure,true);
  assert.equal(result.errorCode,"GROUNDING_VERDICT_COVERAGE_MISMATCH");
});
test("context rejection identifies an exact actionable draft span and rejects opaque booleans", () => {
  const text = "We can help with accounting. We also offer property services.";
  const issue = "We also offer property services.";
  const verdict = { segments:[{text,status:"supported",evidenceRefs:["scope"],reasonCode:"supported"}],languageValid:true,contextValid:false,contextIssues:[issue],requestCoverage:{outcome:"addressed",unmetAspects:[]} };
  const result = validateGroundingVerdict(verdict,text,[{sourceRef:"scope"}]);
  assert.equal(result.valid,false);
  assert.deepEqual(result.blockedClaims,[{sentence:issue,claimClass:"CONTEXT",reasons:["context_mismatch"]}]);
  assert.equal(validateGroundingVerdict({...verdict,contextIssues:[]},text,[{sourceRef:"scope"}]).technicalFailure,true);
  assert.match(buildGroundingReviewMessages({text})[0].content,/quote only the exact offending draft spans in contextIssues/);
});
test("semantic clause segmentation normalizes omitted boundary spaces without losing punctuation coverage", () => {
  const text = "We continue the file within the tax scope—details depend on activity.";
  const segments = ["We continue the file", "within the tax scope—", "details depend on activity."];
  const result = validateGroundingVerdict({ segments:segments.map(text=>({text,status:"non_factual",evidenceRefs:[],reasonCode:"non_factual"})),languageValid:true,contextValid:true,contextIssues:[],requestCoverage:{outcome:"addressed",unmetAspects:[]} },text);
  assert.equal(result.technicalFailure,undefined);
  assert.equal(result.valid,true);
  const omitted = validateGroundingVerdict({segments:[{text:"We continue the file—details depend on activity.",status:"non_factual",evidenceRefs:[],reasonCode:"non_factual"}],languageValid:true,contextValid:true,contextIssues:[],requestCoverage:{outcome:"addressed",unmetAspects:[]} },text);
  assert.equal(omitted.technicalFailure,true);
  assert.equal(omitted.errorCode,"GROUNDING_VERDICT_COVERAGE_MISMATCH");
});
test("grounding coverage accepts presentation bullets while preserving every word and claim", () => {
  const text = "The package covers formation.\n• Name reservation\n• Document preparation.";
  const segments = ["The package covers formation.", "Name reservation", "Document preparation."];
  const result = validateGroundingVerdict({ segments:segments.map(text=>({text,status:"supported",evidenceRefs:["scope"],reasonCode:"supported"})),languageValid:true,contextValid:true,contextIssues:[],requestCoverage:{outcome:"addressed",unmetAspects:[]} },text,[{sourceRef:"scope"}]);
  assert.equal(result.valid,true);
});
test("comparative review receives prior scope, rejects false additions, and permits evidenced additions beside context", () => {
  const context = { currentMessage: "Anything else beyond those?", recentConversation: [{ role: "assistant", content: "We offer consulting and administration." }] };
  const text = "Yes, we also offer consulting and administration.";
  const messages = buildGroundingReviewMessages({ text, context });
  assert.deepEqual(JSON.parse(messages[1].content).history, context.recentConversation);
  assert.match(messages[0].content, /repeated items must not be labeled new/);
  assert.match(messages[0].content, /may briefly restate earlier items for context while separately identifying a genuinely new, supported area/);
  assert.match(messages[0].content, /customer-facing drafts must not narrate what the assistant knows, has evidence, approval, records or confirmation for/);
  const result = validateGroundingVerdict({ segments: [{ text, status: "supported", evidenceRefs: ["scope"], reasonCode: "supported" }], languageValid: true, contextValid: false, contextIssues:[text], requestCoverage:{outcome:"not_addressed",unmetAspects:["Anything else beyond those?"]} }, text, [{ sourceRef: "scope" }]);
  assert.deepEqual(result.reasons, ["context_mismatch", "question_not_answered"]);

  const evidencedAddition = "You mentioned consulting and administration before; company formation is another supported area.";
  const accepted = validateGroundingVerdict({ segments: [{ text: evidencedAddition, status: "supported", evidenceRefs: ["scope"], reasonCode: "supported" }], languageValid: true, contextValid: true, contextIssues:[], requestCoverage:{outcome:"addressed",unmetAspects:[]} }, evidencedAddition, [{ sourceRef: "scope" }], context.currentMessage);
  assert.equal(accepted.valid, true);
});
test("generation and review use the same configured identity across languages, including rejected invented aliases", () => {
  for (const locale of ["ar", "en", "el"]) {
    const draft = "مرحبًا! أنا رافا، مساعد الأعمال الرقمي لمجموعة Refalco.";
    const context = { currentMessage: "Hello", locale, recentConversation: [] };
    const generated = buildDecisionMessages(context);
    const review = buildGroundingReviewMessages({ text: draft, context });
    assert.ok(generated[0].content.includes(reviewIdentity().brand));
    assert.match(generated[0].content, /Preserve configured brand and group names exactly/);
    assert.deepEqual(JSON.parse(review[1].content).identity, reviewIdentity());
    assert.equal(JSON.parse(review[1].content).draft, draft);
    assert.match(review[0].content, /invented agent alias is unsupported/);
    const rejected = validateGroundingVerdict({ segments: [{ text: draft, status: "unsupported", evidenceRefs: [], reasonCode: "no_approved_evidence" }], languageValid: true, contextValid: false, contextIssues:[draft], requestCoverage:{outcome:"addressed",unmetAspects:[]} }, draft);
    assert.equal(rejected.valid, false);
    assert.deepEqual(rejected.reasons, ["no_approved_evidence", "context_mismatch"]);
  }
});
const verdict = (text, status, evidenceRefs = [], reasonCode = status === "unsupported" ? "unsupported_relation" : status) => ({
  segments: [{ text, status, evidenceRefs, reasonCode }], languageValid: true, contextValid: true, contextIssues:[], requestCoverage:{outcome:"addressed",unmetAspects:[]}
});
const evidence = { sourceRef: "source:section", content: "The group assists with company registration. Bank approval is decided by the bank and is not guaranteed.", review_status: "approved" };

test("identity has validated configuration only; credibility and services require evidence", async () => {
  assert.ok(reviewIdentity().brand);
  assert.equal(reviewIdentity().founded, undefined);
  assert.equal(reviewIdentity().services, undefined);
  for (const text of ["أنا REFAL، الوكيل الرقمي لـ Refalco Group في قبرص.", "I represent Refalco Group as its digital agent in Cyprus.", "Είμαι ο ψηφιακός εκπρόσωπος του Refalco Group στην Κύπρο."]) {
    const result = await assessAgentDraft({ text }, { callModel: async (messages) => {
      const input = JSON.parse(messages[1].content);
      assert.deepEqual(input.identity, reviewIdentity()); assert.deepEqual(input.evidence, []);
      return verdict(text, "identity");
    } });
    assert.equal(result.valid, true);
  }
  assert.equal(validateGroundingVerdict(verdict("Established in 2000.", "identity"), "Established in 2000.").valid, false);
});

test("reviewer receives exact approved evidence, translation and negation contract; excludes unapproved rows", async () => {
  const text = "منساعد بالتأسيس، بس قرار البنك إله وما منضمن الموافقة.";
  const result = await assessAgentDraft({ text, evidenceItems: [evidence, { ...evidence, sourceRef: "unapproved", review_status: "pending" }], context: { currentMessage: "فتح الحساب أكيد؟", locale: "arabic" } }, {
    callModel: async (messages) => {
      assert.match(messages[0].content, /Preserve negation, actors, scope, conditions and exceptions/);
      assert.match(messages[0].content, /translation, synonyms, spelling variations/);
      const input = JSON.parse(messages[1].content);
      assert.equal(input.draft, text); assert.equal(input.evidence.length, 1); assert.equal(input.evidence[0].content, evidence.content);
      return verdict(text, "supported", [evidence.sourceRef]);
    }
  });
  assert.equal(result.valid, true);
});

test("reviewer resolves a follow-up to the nearest compatible turn without treating an earlier reply as evidence", async () => {
  const source = { sourceRef: "scope:overview", review_status: "approved", title: "Company service scope",
    content: "The group provides company formation and structuring, tax and accounting, investment, property and development, and residency and relocation services. Company formation is also available on its own." };
  const currentMessage = "Are these all your services, or are there other areas too?";
  const recentConversation = [
    { role: "assistant", content: "Our confirmed areas include formation, tax, property, and residency." },
    { role: "user", content: "I only want company formation, not property or investment." },
    { role: "assistant", content: "The package includes name reservation and document preparation." }
  ];
  const text = "The formation package is not the full scope: approved areas also include tax and accounting, investment, property and development, and residency and relocation.";
  const result = await assessAgentDraft({ text, evidenceItems: [source], context: { currentMessage, recentConversation, locale: "english" } }, {
    callModel: async (messages) => {
      assert.match(messages[0].content, /nearest compatible antecedent/u);
      assert.match(messages[0].content, /Prior assistant claims and fallback replies are context, not approved factual evidence/u);
      const input = JSON.parse(messages[1].content);
      assert.equal(input.history.at(-1).content, recentConversation.at(-1).content);
      assert.equal(input.request, currentMessage);
      assert.equal(input.evidence[0].content, source.content);
      return { segments: [{ text, status: "supported", evidenceRefs: [source.sourceRef], reasonCode: "supported" }],
        languageValid: true, contextValid: true, contextIssues: [], requestCoverage: { outcome: "addressed", unmetAspects: [] } };
    }
  });
  assert.equal(result.valid, true);
});

test("ongoing conversation review sees the prior introduction and rejects a redundant social opener", async () => {
  const priorReply = "مرحبًا، أنا REFAL، مساعد الأعمال الرقمي لدى Refalco Group. كيف أقدر أساعدك؟";
  const request = "مرحبا، ممكن أعرف شو بتقدّموا خدمات بقبرص؟";
  const opener = "أهلًا!";
  const supportedText = "بتقدّم Refalco Group خدمات تأسيس الشركات والهيكلة والضرائب والمحاسبة.";
  const draft = `${opener}\n${supportedText}`;
  const context = { currentMessage: request, locale: "arabic", recentConversation: [
    { role: "user", content: "مرحبا" }, { role: "assistant", content: priorReply }
  ] };
  const result = await assessAgentDraft({ text: draft, evidenceItems: [evidence], context }, {
    callModel: async (messages) => {
      const input = JSON.parse(messages[1].content);
      assert.equal(input.history.at(-1).content, priorReply);
      assert.match(messages[0].content, /assess opening text by its conversational function/);
      assert.match(messages[0].content, /Do not excuse redundant opening text as harmless style/);
      return { segments: [
        { text: opener, status: "non_factual", evidenceRefs: [], reasonCode: "non_factual" },
        { text: supportedText, status: "supported", evidenceRefs: [evidence.sourceRef], reasonCode: "supported" }
      ], languageValid: true, contextValid: false, contextIssues: [opener], requestCoverage: { outcome: "addressed", unmetAspects: [] } };
    }
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.blockedClaims, [{ sentence: opener, claimClass: "CONTEXT", reasons: ["context_mismatch"] }]);
});

test("comparative review rejects a repeated catalogue padded with generic uncertainty", async () => {
  const repeated = "• تأسيس الشركات والهيكلة المؤسسية،\n• الضرائب والمحاسبة،\n• الاستثمار والعقارات والتطوير،\n• وخدمات الإقامة والانتقال.";
  const priorReply = `خدماتنا تشمل:\n${repeated}`;
  const draft = `${repeated}\nما بقدر أكد إذا في مجالات إضافية.`;
  const context = { currentMessage: "هدول كل خدماتكن، ولا في مجالات تانية كمان؟", locale: "arabic", recentConversation: [
    { role: "user", content: "شو بتقدّموا خدمات؟" }, { role: "assistant", content: priorReply }
  ] };
  const result = await assessAgentDraft({ text: draft, evidenceItems: [evidence], context }, {
    callModel: async (messages) => {
      const input = JSON.parse(messages[1].content);
      assert.equal(input.history.at(-1).content, priorReply);
      assert.match(messages[0].content, /repeating the full list already given plus a generic uncertainty disclaimer is redundant/);
      return { segments: [
        { text: repeated, status: "supported", evidenceRefs: [evidence.sourceRef], reasonCode: "supported" },
        { text: "ما بقدر أكد إذا في مجالات إضافية.", status: "non_factual", evidenceRefs: [], reasonCode: "non_factual" }
      ], languageValid: true, contextValid: false, contextIssues: [repeated], requestCoverage: { outcome: "supported_partial", unmetAspects: [] } };
    }
  });
  assert.equal(result.valid, false);
  assert.ok(result.blockedClaims.some((claim) => claim.claimClass === "CONTEXT" && claim.sentence === repeated));
});

test("reviewer distinguishes explicit ongoing scope from adjacent lifecycle procedures", async () => {
  const scope = { sourceRef: "profile:continuity", review_status: "approved", content: "The group keeps the same client file open beyond incorporation. Its connected services include company formation, tax and accounting, investment and property, and residency and relocation." };
  const text = "We continue supporting the client beyond incorporation across the stated service areas; specific registrations and filings depend on the company's circumstances.";
  const result = await assessAgentDraft({ text, evidenceItems: [scope], context: { currentMessage: "What can you help with after the company is formed?", locale: "english" } }, {
    callModel: async (messages) => {
      assert.match(messages[0].content, /explicitly describes the group's continuing role across a client file or beyond incorporation/);
      assert.match(messages[0].content, /does not, by itself, establish that the company performs every adjacent procedure/);
      const input = JSON.parse(messages[1].content);
      assert.equal(input.evidence[0].ref, scope.sourceRef);
      assert.equal(input.evidence[0].content, scope.content);
      return { segments: [{ text, status: "supported", evidenceRefs: [scope.sourceRef], reasonCode: "supported" }], languageValid: true, contextValid: true, contextIssues: [], requestCoverage: { outcome: "addressed", unmetAspects: [] } };
    }
  });
  assert.equal(result.valid, true);
});

test("omitted claim text, fabricated references, unsupported relations and dropped conditions fail closed", () => {
  assert.equal(validateGroundingVerdict(verdict("A supported sentence.", "supported", [evidence.sourceRef]), "A supported sentence. An invented service.", [evidence]).technicalFailure, true);
  assert.equal(validateGroundingVerdict(verdict("A claim.", "supported", ["absent"]), "A claim.", [evidence]).valid, false);
  for (const code of ["unsupported_relation", "condition_missing", "service_not_established", "contradicted_by_evidence"]) {
    const result = validateGroundingVerdict(verdict("An unsupported claim.", "unsupported", [], code), "An unsupported claim.", [evidence]);
    assert.equal(result.valid, false); assert.equal(result.blockedClaims[0].sentence, "An unsupported claim."); assert.deepEqual(result.reasons, [code]);
  }
});

test("guarantees and phishing remain deterministically blocked even with an erroneous approving reviewer", async () => {
  for (const text of ["We guarantee bank approval.", "فتح حسابك البنكي مضمون.", "Εγγυόμαστε την έγκριση της τράπεζας.", "Please send your password and PIN."]) {
    let reviews = 0;
    const result = await runAgentTurnForContact({ currentMessage: "Tell me the requirements", locale: "english" }, {
      decideNextStep: async () => ({ type: "respond", text }), assessDraft: async () => { reviews++; return { valid: true }; }
    });
    assert.equal(result.outcome, "response_rejected", text); assert.equal(reviews, 0, text);
  }
});

test("reviewer provider outage stops once and records a technical cause rather than missing knowledge", async () => {
  let calls = 0;
  const result = await runAgentTurnForContact({ currentMessage: "Hello", locale: "english" }, {
    decideNextStep: async () => ({ type: "respond", text: "Hello, I represent Refalco Group." }),
    assessDraft: (input) => assessAgentDraft(input, { callModel: async () => { calls++; throw Object.assign(new Error("private provider body"), { status: 503 }); } })
  });
  assert.equal(result.outcome, "validation_failed"); assert.equal(result.reason, "HTTP_503"); assert.equal(calls, 1);
});

test("current trusted dynamic records have reviewer references for supported pricing", async () => {
  const text = "The listed package costs EUR 500, subject to its stated conditions.";
  const result = await assessAgentDraft({ text, dynamicEvidenceItems: [{ kind: "offers", trustedDynamic: true, content: "EUR 500; published package price; applicability requires review." }] }, {
    callModel: async (messages) => { const data = JSON.parse(messages[1].content); assert.equal(data.evidence[0].ref, "dynamic:offers:0"); return verdict(text, "supported", [data.evidence[0].ref]); }
  });
  assert.equal(result.valid, true);
});
