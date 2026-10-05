// Real model-backed decision step for the bounded Agent loop (src/agentLoop.js).
//
// This is the one place in the refactor where the model's raw output is
// parsed. It is never trusted directly: any unparseable JSON, any JSON
// missing a valid `type`, or a failed model call becomes a safe fallback
// decision object that `agentLoop.js`'s `validateDecision` will reject
// through its existing, already-tested invalid-decision path — never a
// thrown error, and never raw model prose mistaken for an action.
//
// The tool list offered to the model is generated from the real
// TOOL_REGISTRY so the model can never be told about a tool that doesn't
// exist.

const { TOOL_REGISTRY } = require("./agentTools");
const { redactPersonalData } = require("./ai");
const { resolveOpenRouterModel, withOpenRouterPrivacyPolicy, DEFAULT_OPENROUTER_MODEL } = require("./openrouterPrivacy");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DECISION_TYPES = new Set(["tool", "respond", "clarify"]);

function buildToolListText(tools) {
  const entries = Object.entries(tools || {});
  if (entries.length === 0) return "(no tools available this turn)";
  return entries.map(([name, tool]) => `- ${name}: ${tool?.description || ""}`).join("\n");
}

function summarizeObservation(observation) {
  const { step, tool, args, result } = observation || {};
  const outcome = result?.ok ? `ok (${result.status})` : `failed (${result?.reasonCode || result?.status || "unknown"})`;
  const summary = result?.userSafeSummary !== undefined ? ` — ${JSON.stringify(result.userSafeSummary).slice(0, 300)}` : "";
  return `Step ${step}: called ${tool} with ${JSON.stringify(args || {}).slice(0, 300)} -> ${outcome}${summary}`;
}

function buildDecisionMessages(context = {}, observations = [], tools = TOOL_REGISTRY) {
  const toolList = buildToolListText(tools);
  const recentConversation = Array.isArray(context.recentConversation) ? context.recentConversation : [];
  const recentText = recentConversation.length
    ? recentConversation.map((turn) => `${turn.role}: ${redactPersonalData(turn.content || "")}`).join("\n")
    : "(no prior turns this conversation)";
  const observationsText = Array.isArray(observations) && observations.length
    ? observations.map(summarizeObservation).join("\n")
    : "(no tool calls yet this turn)";

  const system = [
    "You are the decision step inside REFAL, the digital business agent of REFALCO GROUP.",
    "Decide the SINGLE next step for the current customer message. Reply with ONLY one JSON object and nothing else — no prose, no markdown code fences.",
    'Valid shapes: {"type":"tool","tool":"<tool name>","args":{...}} or {"type":"respond","text":"..."} or {"type":"clarify","text":"..."}',
    "Available tools:",
    toolList,
    "Decision rules:",
    "- Prioritize the customer's current message. Answer it before anything else.",
    "- Ask at most one question, and only if it is genuinely necessary to help. Zero questions is valid and often correct — do not ask just because a field is empty.",
    "- Never offer pricing, booking, or a specialist/handover unless the customer's current message actually asks for it.",
    "- Never state a fact that is not present in a tool result below or in the recent conversation. If no tool result supports a factual claim the customer needs, call searchApprovedKnowledge first, or say in your response that it is not confirmed.",
    "- If a tool result or the recent conversation already answers the current question, respond now instead of calling another tool.",
    "- Mirror the customer's current language in any respond/clarify text.",
    "- Do not repeat a question or offer already present in the recent conversation."
  ].join("\n");

  const user = [
    `Customer's current message (locale: ${context.locale || "unknown"}): ${redactPersonalData(context.currentMessage || "")}`,
    "",
    "Recent conversation:",
    recentText,
    "",
    "Tool results so far this turn:",
    observationsText
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// Defensive JSON extraction: strips a markdown fence if the model added one
// anyway, and requires a recognized `type` before returning anything.
function parseDecisionJson(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !DECISION_TYPES.has(parsed.type)) return null;
  return parsed;
}

async function defaultCallModel(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
  const model = resolveOpenRouterModel(process.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL);

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost/whatsapp-company-bot",
      "X-OpenRouter-Title": "RAFA"
    },
    body: JSON.stringify(withOpenRouterPrivacyPolicy({
      model,
      max_tokens: 300,
      reasoning: { enabled: false, exclude: true },
      temperature: 0.2,
      messages
    }))
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `OpenRouter HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenRouter returned no decision content.");
  return content;
}

// Never returned as-is to the caller's loop as a "valid" decision: its
// `text` is null, so agentLoop.js's validateDecision will reject it through
// the normal invalid-decision path (missing_response_text).
function fallbackDecision(reason) {
  return { type: "respond", text: null, invalid: true, reason };
}

async function decideNextStep({ context, observations = [], step = 1 } = {}, { callModel = defaultCallModel, tools = TOOL_REGISTRY } = {}) {
  const messages = buildDecisionMessages(context, observations, tools);
  let raw;
  try {
    raw = await callModel(messages, { context, observations, step });
  } catch (error) {
    return fallbackDecision(`model_call_failed:${String(error?.message || error).slice(0, 150)}`);
  }
  const parsed = parseDecisionJson(raw);
  if (!parsed) return fallbackDecision("unparseable_decision");
  return parsed;
}

module.exports = { decideNextStep, buildDecisionMessages, buildToolListText, parseDecisionJson, defaultCallModel };
