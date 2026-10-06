// REFAL-AGENT-016 — isolated LLM-as-judge for the semantic dimensions that
// cannot be scored deterministically from runtime state (whether a response
// actually answered the customer's current request; whether an asked
// question was semantically necessary). Deliberately separate from
// agentDecision.js's decision model/prompt — the judge never sees the
// decision model's reasoning, only the final customer-facing text, and uses
// its own model/prompt so a judge call can never leak into or bias the
// Agent's own decision loop.
//
// Deterministic facts (whether a booking/handover was persisted, whether a
// response contains a question, language mismatch, tool usage) are NEVER
// delegated to this evaluator — those come from runtime telemetry
// (agentObservability.js) and responsePolicy.js, not from model judgment.
//
// No chain-of-thought is requested; the schema is the only allowed output.

const { fetchOpenRouter } = require("./openrouterTransport");

const EVALUATOR_PROMPT_VERSION = "2026-10-05.v1";
const EVALUATOR_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_EVALUATOR_MODEL = "deepseek/deepseek-v4.1-flash";

const REASON_CODES = Object.freeze([
  "DIRECTLY_ANSWERED",
  "PARTIALLY_ANSWERED",
  "IGNORED_REQUEST",
  "ASKED_UNNECESSARY_QUESTION_INSTEAD",
  "SAFE_BOUNDARY_STATEMENT",
  "CLARIFICATION_WAS_NECESSARY"
]);

function buildEvaluatorMessages({ customerMessage, locale, response }) {
  const system = [
    "You are a narrow evaluator for a customer-service transcript. You are NOT the assistant that wrote the reply.",
    "Score ONLY the two fields below. Reply with ONLY one JSON object, nothing else — no prose, no markdown fences, no explanation.",
    'Schema: {"currentRequestAnswered": boolean, "unnecessaryQuestion": boolean, "reasonCode": one of ' + JSON.stringify(REASON_CODES) + "}",
    "currentRequestAnswered: true if the reply substantively addresses what the customer most recently asked or stated (a safe boundary statement like 'I don't have confirmed information on that' counts as answered).",
    "unnecessaryQuestion: true if the reply asks a question that was not genuinely required to help with the customer's current request. A reply with zero questions is never 'unnecessary' — score it false.",
    "Do not evaluate language, tone, or tool usage. Do not include any text outside the JSON object."
  ].join("\n");
  const user = [
    `Locale: ${locale || "unknown"}`,
    `Customer message: ${String(customerMessage || "").slice(0, 1000)}`,
    `Assistant reply being evaluated: ${String(response || "").slice(0, 1000)}`
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function parseEvaluatorJson(raw) {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.currentRequestAnswered !== "boolean") return null;
  if (typeof parsed.unnecessaryQuestion !== "boolean") return null;
  if (!REASON_CODES.includes(parsed.reasonCode)) return null;
  return { currentRequestAnswered: parsed.currentRequestAnswered, unnecessaryQuestion: parsed.unnecessaryQuestion, reasonCode: parsed.reasonCode };
}

async function defaultCallEvaluatorModel(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
  const model = process.env.BENCHMARK_EVALUATOR_MODEL || DEFAULT_EVALUATOR_MODEL;
  const response = await fetchOpenRouter(EVALUATOR_URL, {
    method: "POST",
    timeoutMs: 20000,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "http://localhost/whatsapp-company-bot", "X-OpenRouter-Title": "RAFA-benchmark-evaluator" },
    body: JSON.stringify({ model, max_tokens: 150, reasoning: { enabled: false, exclude: true }, temperature: 0, messages, provider: { data_collection: "deny", zdr: true } })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `OpenRouter HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Evaluator returned no content.");
  return content;
}

// Returns either a validated structured result, or an explicit
// evaluatorUnavailable marker — NEVER a guessed/defaulted true/false, so the
// scorer can correctly treat this dimension as NOT_APPLICABLE rather than a
// fabricated pass or fail.
async function judgeResponse({ customerMessage, locale, response }, { callModel = defaultCallEvaluatorModel } = {}) {
  if (!response || !String(response).trim()) {
    return { evaluatorUnavailable: true, reason: "no_response_to_judge" };
  }
  const messages = buildEvaluatorMessages({ customerMessage, locale, response });
  let raw;
  try {
    raw = await callModel(messages);
  } catch (error) {
    return { evaluatorUnavailable: true, reason: `model_call_failed:${String(error?.message || error).slice(0, 150)}` };
  }
  const parsed = parseEvaluatorJson(raw);
  if (!parsed) return { evaluatorUnavailable: true, reason: "unparseable_or_invalid_schema" };
  return { evaluatorUnavailable: false, ...parsed, promptVersion: EVALUATOR_PROMPT_VERSION };
}

module.exports = { EVALUATOR_PROMPT_VERSION, REASON_CODES, buildEvaluatorMessages, parseEvaluatorJson, judgeResponse, defaultCallEvaluatorModel };
