const { withOpenRouterPrivacyPolicy, resolveOpenRouterModel, DEFAULT_OPENROUTER_MODEL } = require("../src/openrouterPrivacy");
const { redactSensitiveData } = require("../src/sensitiveData");
const { detectExplicitLanguageRequest, detectMessageLanguage } = require("../src/language");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const LANGUAGE_STYLE = {
  en: "natural, concise conversational English",
  ar: "easy, readable Syrian/Levantine Arabic (not formal Arabic)",
  el: "simple, professional Greek"
};

const LANGUAGE_NAMES = { en: "english", ar: "arabic", el: "greek" };

function expectedCustomerLanguage(locale, conversation, scenario = "") {
  const userTurns = (Array.isArray(conversation) ? conversation : []).filter((turn) => turn?.role !== "assistant");
  for (const turn of userTurns.slice().reverse()) {
    const requested = detectExplicitLanguageRequest(turn.content);
    if (requested) return requested;
  }
  // Scripted transliteration/Greeklish families establish language by locale;
  // script-only detection otherwise mistakes romanized turns for English.
  if (["transliteration", "greeklish"].includes(scenario)) return LANGUAGE_NAMES[locale] || "english";
  const latestLanguage = userTurns.length ? detectMessageLanguage(userTurns.at(-1).content) : null;
  return latestLanguage || LANGUAGE_NAMES[locale] || "english";
}

function safeSimulatorFailureReason(error) {
  const code = String(error?.code || error?.message || "");
  if (/customer-model-language-mismatch/u.test(code)) return "language_mismatch";
  if (/customer-model-output-rejected/u.test(code)) return "output_rejected";
  if (/customer-model-http-(\d{3})/u.test(code)) return `http_${code.match(/customer-model-http-(\d{3})/u)[1]}`;
  if (/OPENROUTER_API_KEY/u.test(code)) return "missing_api_key";
  if (error?.name === "AbortError" || /abort|timed? ?out|timeout/iu.test(code)) return "timeout";
  return "provider_error";
}

async function simulateCustomerTurn({ locale, scenario, plannedMessage, persona, responseBeat, seed, conversation, allowLanguageSwitch = false, apiKey = process.env.OPENROUTER_API_KEY, model = process.env.OPENROUTER_CUSTOMER_MODEL || process.env.OPENROUTER_MODEL, fetchImpl = globalThis.fetch, onUsage = () => {} }) {
  if (!apiKey) throw new Error("Live synthetic customer simulation requires OPENROUTER_API_KEY.");
  const languageStyle = LANGUAGE_STYLE[locale] || LANGUAGE_STYLE.en;
  const safeConversation = (Array.isArray(conversation) ? conversation : []).slice(-8).map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    content: redactSensitiveData(turn.content).slice(0, 900)
  }));
  const payload = withOpenRouterPrivacyPolicy({
    model: resolveOpenRouterModel(model, DEFAULT_OPENROUTER_MODEL),
    max_tokens: 160,
    temperature: 0.55,
    reasoning: { enabled: false, exclude: true },
    usage: { include: true },
    ...(Number.isInteger(seed) ? { seed } : {}),
    messages: [
      {
        role: "system",
        content: `You are roleplaying a synthetic prospective the business customer in a private quality benchmark. Write only the customer's next WhatsApp message in ${languageStyle}. Never answer as REFAL, narrate, or mention a test. Scenario: ${String(scenario || "general").slice(0, 80)}. Persona: ${String(persona || "A realistic prospective customer; reveal details gradually.").slice(0, 350)}\n\nRead the whole recent exchange and react to what the agent actually said. A possible concern in your conversation plan is: ${redactSensitiveData(String(plannedMessage || "")).slice(0, 500)}. This is context, not required wording or a mandatory point. Raise it only if it still makes sense and has not already been answered. If the agent answered it, do not repeat, paraphrase, or re-ask it; acknowledge the useful answer briefly or move to the next natural concern. ${String(responseBeat || "Respond naturally to the agent's latest reply.").slice(0, 260)} If the agent misunderstood you, correct that naturally. If it asks for details you do not want to share, decline and offer a less sensitive alternative. If it pressures you after a decline, restate your boundary; otherwise do not force a refusal. You may be hesitant, impatient, or change to a related practical question when it fits your persona and the conversation. Do not insert every behavior mechanically.\n\nStay believable and brief (usually one or two sentences), keep one clear conversational move, and do not invent personal identifiers, addresses, phone numbers, credentials, financial details, or business facts beyond what this conversation establishes. Do not add unrelated topics.`
      },
      ...safeConversation,
      { role: "user", content: "Write the next customer message now. Output only that message." }
    ]
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "http://localhost/whatsapp-company-bot", "X-OpenRouter-Title": "REFAL synthetic benchmark" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`customer-model-http-${response.status}`);
    onUsage(body?.usage || {});
    let message = body?.choices?.[0]?.message?.content;
    if (Array.isArray(message)) message = message.map((part) => part?.text || "").join(" ");
    message = redactSensitiveData(String(message || "")).replace(/<think>[\s\S]*?<\/think>/giu, "").trim().replace(/^['"“”]+|['"“”]+$/gu, "");
    if (!message || message.length > 480 || /(?:FAKE-ONLY-Secret-7241|4111111111111111|(?:sk-|ghp_|xoxb-)[A-Za-z0-9_-]{12,})/iu.test(message)) throw new Error("customer-model-output-rejected");
    const actualLanguage = detectMessageLanguage(message);
    const expectedLanguage = expectedCustomerLanguage(locale, conversation, scenario);
    if (!allowLanguageSwitch && actualLanguage && actualLanguage !== expectedLanguage) throw new Error("customer-model-language-mismatch");
    return { message, usedModel: true, usage: body?.usage || null, model: payload.model, seed: payload.seed ?? null };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { expectedCustomerLanguage, safeSimulatorFailureReason, simulateCustomerTurn };
