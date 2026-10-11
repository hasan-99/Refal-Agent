"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assessAgentDraft, validateGroundingVerdict, reviewIdentity } = require("./semanticGrounding");
const { runAgentTurnForContact } = require("./agentRuntime");
const { buildDecisionMessages } = require("./agentDecision");
const { buildGroundingReviewMessages } = require("./semanticGrounding");
test("comparative review receives the actual prior scope and rejects treating repeated categories as new", () => {
  const context = { currentMessage: "Anything else beyond those?", recentConversation: [{ role: "assistant", content: "We offer consulting and administration." }] };
  const text = "Yes, we also offer consulting and administration.";
  const messages = buildGroundingReviewMessages({ text, context });
  assert.deepEqual(JSON.parse(messages[1].content).history, context.recentConversation);
  assert.match(messages[0].content, /previously listed items are presented as additional/);
  const result = validateGroundingVerdict({ segments: [{ text, status: "supported", evidenceRefs: ["scope"], reasonCode: "supported" }], languageValid: true, contextValid: false, answerAddressesQuestion: false }, text, [{ sourceRef: "scope" }]);
  assert.deepEqual(result.reasons, ["context_mismatch", "question_not_answered"]);
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
    const rejected = validateGroundingVerdict({ segments: [{ text: draft, status: "unsupported", evidenceRefs: [], reasonCode: "no_approved_evidence" }], languageValid: true, contextValid: false, answerAddressesQuestion: true }, draft);
    assert.equal(rejected.valid, false);
    assert.deepEqual(rejected.reasons, ["no_approved_evidence", "context_mismatch"]);
  }
});
const verdict = (text, status, evidenceRefs = [], reasonCode = status === "unsupported" ? "unsupported_relation" : status) => ({
  segments: [{ text, status, evidenceRefs, reasonCode }], languageValid: true, contextValid: true, answerAddressesQuestion: true
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
