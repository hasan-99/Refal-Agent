// Bounded Agent decision loop (Phases 3-5 of the refactor).
//
// Core rule: AGENT DECIDES, CODE AUTHORIZES. `decideNextStep` is model-driven
// and may be wrong, confused, or even adversarially manipulated by untrusted
// retrieved/customer content — this file never trusts its output directly.
// Every tool call is validated against the explicit registry before running,
// and every final response/clarification is validated with the same
// deterministic `responsePolicy.validateResponse` already used elsewhere in
// the codebase, before it is allowed to leave this function.

const { validateResponse, safeFallbackData, MODEL_DRAFT_THRESHOLDS, AGENT_CLARIFY_THRESHOLDS } = require("./responsePolicy");
// REFAL-AGENT-028: deterministic factual-grounding gate, additive to the
// existing responsePolicy check below — never a replacement for it. Checked
// only once the ordinary policy check already passed, so every existing
// rejection reason/path is untouched; this can only add a NEW rejection
// reason, never remove one.
const { validateFactualGrounding, collectApprovedKnowledgeEvidence } = require("./groundingPolicy");
// M1 close — the three output gates the Agent path was missing. Each had
// exactly one caller in the repo (src/ai.js), so flipping the Agent flag
// silently dropped every M1 guard while their unit tests stayed green.
const { resolveHumourLevel, assertHumourCompliance } = require("./humourEngine");
const { detectAntiPatterns } = require("./antiPatterns");
const { detectIntents } = require("./intent");
const { detectMessageLanguage } = require("./language");
// REFAL-AGENT-026: ports the legacy ai.js wrong-language check (`answer.length
// > 8 && detectMessageLanguage(answer) !== language`) into the Agent path.
// Reuses agentObservability.js's existing languageSignalsFrom — the SAME
// detector legacy already trusts (src/language.js) compared against
// `context.locale`, the Agent's own trusted per-turn expected-language field
// (set by the caller before the decision loop ever runs — never something
// the model itself reports). languageSignalsFrom is otherwise a read-only
// telemetry helper; reusing it here does not change its own behavior or
// make it a gate on its own — only this file's use of its return value gates.
const { languageSignalsFrom } = require("./agentObservability");

const DEFAULT_MAX_STEPS = 4;
const DECISION_TYPES = new Set(["tool", "respond", "clarify"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The Agent may only ever name a tool that is actually registered — it can
// never invent one. A plain object for `args`; anything else is rejected
// before a tool ever sees it.
function validateDecision(decision, tools) {
  if (!isPlainObject(decision) || !DECISION_TYPES.has(decision.type)) {
    return { ok: false, reason: "decision_not_understood" };
  }
  if (decision.type === "tool") {
    if (typeof decision.tool !== "string" || !Object.hasOwn(tools, decision.tool)) {
      return { ok: false, reason: "unknown_tool_requested" };
    }
    if (decision.args !== undefined && !isPlainObject(decision.args)) {
      return { ok: false, reason: "invalid_tool_args" };
    }
    return { ok: true, type: "tool", tool: decision.tool, args: decision.args || {} };
  }
  // respond / clarify
  if (typeof decision.text !== "string" || !decision.text.trim()) {
    return { ok: false, reason: "missing_response_text" };
  }
  return { ok: true, type: decision.type, text: decision.text.trim() };
}

function languageKeyFromLocale(locale) {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("ar")) return "ar";
  if (value.startsWith("el") || value.startsWith("greek")) return "el";
  return "en";
}

function safeFallback(context, category = "uncertainty") {
  return safeFallbackData({ language: languageKeyFromLocale(context?.locale), category }).text;
}

// A mechanical, safe correction for exactly one rejection reason: too many
// questions. Truncating to the first question mark is safe precisely
// because it only ever removes text, never invents or alters a claim — for
// every other reason (prohibited claim, unconsented contact commitment,
// internal reasoning, wrong length) a truncation could leave a misleading
// fragment, so those are never "corrected," only retried or given up on.
function correctTooManyQuestions(text) {
  const match = /^[\s\S]*?[?؟]/u.exec(String(text || ""));
  return match ? match[0].trim() : null;
}

function attemptDeterministicCorrection(text, policy, thresholds) {
  if (policy.reasons.length !== 1 || policy.reasons[0] !== "too_many_questions") return null;
  const corrected = correctTooManyQuestions(text);
  if (!corrected) return null;
  const recheck = validateResponse(corrected, thresholds);
  return recheck.valid ? recheck.text : null;
}

// Fed back to decideNextStep as an observation so a retried decision can see
// *why* its last draft was rejected, reusing agentDecision.js's existing
// observation formatting (it only expects {step, tool, args, result}).
function policyRejectionObservation(step, decisionType, policy) {
  return {
    step,
    tool: "responsePolicyCheck",
    args: { attemptedType: decisionType },
    result: { ok: false, status: "policy_rejected", reasonCode: policy.reasons.join(",") }
  };
}

// REFAL-AGENT-026 — mirrors legacy ai.js's own short-text exemption
// (`answer.length > 8`): a very short draft (e.g. a one-word acknowledgement)
// is too little text for script-based language detection to be reliable, so
// it is never rejected on language grounds alone, matching legacy exactly.
// `locale` is always `context.locale` — trusted, caller-supplied, never
// something the model's own decision JSON can set.
function checkLanguageEquivalence(text, locale) {
  const trimmed = String(text || "").trim();
  if (trimmed.length <= 8) return { valid: true, reasons: [] };
  const signal = languageSignalsFrom(locale, trimmed);
  // languageMismatch is null (not computed) when locale is "unknown" or the
  // text is empty — nothing meaningful to compare, never treated as a
  // rejection. Only an explicit `true` gates.
  if (signal.languageMismatch !== true) return { valid: true, reasons: [] };
  return { valid: false, reasons: ["language_mismatch"] };
}

// REFAL-AGENT-028/026 — runs the existing responsePolicy check first,
// unchanged; only if that already passes does it additionally run the
// deterministic factual-grounding check against the evidence this turn's
// tool calls actually surfaced (Ticket 027's modelObservation channel, never
// a tool's raw `data`), then the language-equivalence check (Ticket 026).
// Each failure is folded into the same `{valid, text, reasons}` shape
// validateResponse already returns, so every downstream consumer
// (attemptDeterministicCorrection, policyRejectionObservation, the
// retry/fallback branching below) needs no special-casing: neither a
// grounding nor a language-mismatch reason ever equals "too_many_questions",
// so neither is ever mistaken for one the mechanical correction knows how to
// fix — both only ever go through retry-then-fallback, never a silent text edit.
function checkDraftPolicy(text, thresholds, observations, locale, context = {}) {
  const policy = validateResponse(text, thresholds);
  if (!policy.valid) return policy;
  const evidenceItems = collectApprovedKnowledgeEvidence(observations);
  const grounding = validateFactualGrounding(text, { evidenceItems });
  if (!grounding.valid) return { ...policy, valid: false, reasons: grounding.reasons };
  const language = checkLanguageEquivalence(text, locale);
  if (!language.valid) return { ...policy, valid: false, reasons: language.reasons };

  // M1 close — the Agent path was running THREE fewer output gates than the
  // legacy path. detectAntiPatterns, assertHumourCompliance and
  // assertModelKnowledgeIsGeneral each had exactly one caller in the repo,
  // src/ai.js, which this path does not traverse. So every M1 guard silently
  // disappeared the moment REFAL_AGENT_LIVE_ENABLED was flipped, while
  // antiPatterns.test.js and humourEngine.test.js stayed green. Two of the
  // three are wired here, at the single composition point, so they fold into
  // the same {valid, reasons} shape the retry/fallback branching already
  // handles and need no special-casing.
  //
  // assertModelKnowledgeIsGeneral is deliberately NOT wired: it keys off a
  // MODEL_KNOWLEDGE source level that cannot arise here any more than it can
  // in ai.js, so adding it would create a second dead gate rather than a
  // second real one. Recorded as W1.6.3 PARTIAL in the plan instead.
  const message = String(context.currentMessage || "");
  const history = Array.isArray(context.recentConversation) ? context.recentConversation : [];

  const humourLevel = resolveHumourLevel({
    message,
    history,
    intents: detectIntents(message),
    language: detectMessageLanguage(message)
  }).level;
  const humour = assertHumourCompliance(text, humourLevel);
  // A joke next to a bereavement is regenerated, never silently edited; a
  // disallowed emoji is stripped in place. Same split as src/ai.js.
  if (humour.rejected) {
    return { ...policy, valid: false, reasons: ["humour_above_level"] };
  }
  const cleaned = humour.ok ? policy.text : humour.sanitized;

  const antiPatterns = detectAntiPatterns({
    answer: cleaned,
    customerMessage: message,
    history,
    leadTier: context.leadTier || "",
    deliveredApprovedFact: evidenceItems.length > 0,
    evidenceText: evidenceItems.map((item) => String(item?.content || "")).join("\n")
  });
  if (antiPatterns.length) {
    return { ...policy, valid: false, reasons: antiPatterns.map((violation) => `anti_pattern:${violation.id}`) };
  }

  return { ...policy, text: cleaned };
}

// deps:
//   decideNextStep({ context, observations, step }) -> a raw, untrusted decision object (model-driven)
//   tools: { [name]: { run(args, toolContext) } }       -- the deterministic tool registry
//   toolContext: extra data (store, user, etc.) passed through to every tool.run call
//   maxSteps: bounded step budget, default 4 (never unlimited)
async function runAgentTurn(context, { decideNextStep, tools = {}, toolContext = {}, maxSteps = DEFAULT_MAX_STEPS } = {}) {
  if (typeof decideNextStep !== "function") throw new Error("runAgentTurn requires a decideNextStep function.");
  const observations = [];
  const toolsUsed = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    let rawDecision;
    try {
      rawDecision = await decideNextStep({ context, observations, step });
    } catch (error) {
      return {
        finished: true,
        outcome: "decision_failed",
        response: safeFallback(context),
        steps: observations,
        toolsUsed,
        stepCount: step,
        reason: String(error?.message || error).slice(0, 200)
      };
    }

    const validated = validateDecision(rawDecision, tools);
    if (!validated.ok) {
      return {
        finished: true,
        outcome: "invalid_decision",
        response: safeFallback(context),
        steps: observations,
        toolsUsed,
        stepCount: step,
        reason: validated.reason
      };
    }

    if (validated.type === "tool") {
      const tool = tools[validated.tool];
      let result;
      try {
        result = await tool.run(validated.args, toolContext);
      } catch (error) {
        result = { ok: false, status: "error", reasonCode: "TOOL_THREW", message: String(error?.message || error).slice(0, 200) };
      }
      observations.push({ step, tool: validated.tool, args: validated.args, result });
      toolsUsed.push(validated.tool);
      continue;
    }

    if (validated.type === "respond") {
      const thresholds = MODEL_DRAFT_THRESHOLDS;
      const policy = checkDraftPolicy(validated.text, thresholds, observations, context?.locale, context);
      if (!policy.valid) {
        const corrected = attemptDeterministicCorrection(validated.text, policy, thresholds);
        if (corrected) {
          return { finished: true, outcome: "responded", response: corrected, steps: observations, toolsUsed, stepCount: step, corrected: true };
        }
        if (step < maxSteps) {
          observations.push(policyRejectionObservation(step, "respond", policy));
          continue;
        }
        return {
          finished: true,
          outcome: "response_rejected",
          response: safeFallback(context),
          steps: observations,
          toolsUsed,
          stepCount: step,
          reason: policy.reasons.join(",")
        };
      }
      return { finished: true, outcome: "responded", response: policy.text, steps: observations, toolsUsed, stepCount: step };
    }

    // clarify: at most one question, no minimum length requirement — a short
    // single clarifying question is exactly what this path is for.
    const clarifyThresholds = AGENT_CLARIFY_THRESHOLDS;
    const policy = checkDraftPolicy(validated.text, clarifyThresholds, observations, context?.locale, context);
    if (!policy.valid) {
      const corrected = attemptDeterministicCorrection(validated.text, policy, clarifyThresholds);
      if (corrected) {
        return { finished: true, outcome: "clarified", response: corrected, steps: observations, toolsUsed, stepCount: step, corrected: true };
      }
      if (step < maxSteps) {
        observations.push(policyRejectionObservation(step, "clarify", policy));
        continue;
      }
      return {
        finished: true,
        outcome: "clarify_rejected",
        response: safeFallback(context),
        steps: observations,
        toolsUsed,
        stepCount: step,
        reason: policy.reasons.join(",")
      };
    }
    return { finished: true, outcome: "clarified", response: policy.text, steps: observations, toolsUsed, stepCount: step };
  }

  return {
    finished: true,
    outcome: "max_steps_reached",
    response: safeFallback(context),
    steps: observations,
    toolsUsed,
    stepCount: maxSteps
  };
}

module.exports = { runAgentTurn, validateDecision, DEFAULT_MAX_STEPS };
