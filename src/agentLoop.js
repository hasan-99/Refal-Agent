// Bounded Agent decision loop (Phases 3-5 of the refactor).
//
// Core rule: AGENT DECIDES, CODE AUTHORIZES. `decideNextStep` is model-driven
// and may be wrong, confused, or even adversarially manipulated by untrusted
// retrieved/customer content — this file never trusts its output directly.
// Every tool call is validated against the explicit registry before running,
// and every final response/clarification is validated with the same
// deterministic `responsePolicy.validateResponse` already used elsewhere in
// the codebase, before it is allowed to leave this function.

const { validateResponse, safeFallbackData } = require("./responsePolicy");

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
      const thresholds = { minSentences: 1, maxSentences: 5, maxQuestions: 1, maxChars: 500 };
      const policy = validateResponse(validated.text, thresholds);
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
    const clarifyThresholds = { minSentences: 0, maxSentences: 2, maxQuestions: 1, maxChars: 300 };
    const policy = validateResponse(validated.text, clarifyThresholds);
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
