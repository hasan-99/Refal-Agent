const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function companyContext(company) {
  const faqs = (company.faqs || [])
    .map((faq) => `- ${faq.title}: ${faq.answer}`)
    .join("\n");

  return [
    `Company: ${company.companyName}`,
    `Description: ${company.shortDescription}`,
    `Location: ${company.location}`,
    `Hours: ${company.hours}`,
    `Contact phone: ${company.contact?.phone || "not set"}`,
    `Contact email: ${company.contact?.email || "not set"}`,
    `Website: ${company.contact?.website || "not set"}`,
    `Services: ${(company.services || []).join(", ")}`,
    `FAQs:\n${faqs}`
  ].join("\n");
}

function recentHistory(user) {
  return (user.history || [])
    .slice(-8)
    .map((item) => [
      { role: "user", content: String(item.message || "") },
      { role: "assistant", content: String(item.response || "") }
    ])
    .flat();
}

async function askOpenRouter({ text, user, company }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENROUTER_MODEL || "openrouter/free";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost/whatsapp-company-bot",
        "X-OpenRouter-Title": "WhatsApp Company Bot"
      },
      body: JSON.stringify({
        model,
        max_tokens: 220,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content: [
              `You are the WhatsApp assistant for ${company.companyName}.`,
              "Answer naturally, briefly, and helpfully.",
              "Use only the company information provided below for business facts.",
              "If the user asks for something unknown, ask one short follow-up question or offer contact details.",
              "Do not invent prices, addresses, phone numbers, services, or guarantees.",
              "Keep replies under 700 characters.",
              "",
              companyContext(company),
              "",
              "Known saved user profile:",
              JSON.stringify(user.profile || {})
            ].join("\n")
          },
          ...recentHistory(user),
          { role: "user", content: text }
        ]
      })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message || `OpenRouter HTTP ${response.status}`);
    }

    const answer = body?.choices?.[0]?.message?.content?.trim();
    return answer || null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { askOpenRouter };
