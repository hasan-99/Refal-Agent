const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurn, validateDecision, DEFAULT_MAX_STEPS } = require("./agentLoop");
const { buildAgentContext } = require("./agentContext");

const BASE_CONTEXT = buildAgentContext({ currentMessage: "What is the price to create a Cyprus company?", locale: "english" });

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

test("DEFAULT_MAX_STEPS is a small bounded number, never unlimited", () => {
  assert.equal(DEFAULT_MAX_STEPS, 4);
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
