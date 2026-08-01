const STEPS = [
  {
    key: "name",
    question: "Hello. What is your name?"
  },
  {
    key: "company",
    question: "What company or project is this for?"
  },
  {
    key: "need",
    question: "What do you need help with?"
  }
];

const HELP = [
  "This bot replies inside WhatsApp from the linked business number.",
  "Commands:",
  "start - begin or continue",
  "profile - show your saved details",
  "reset - clear your saved details",
  "services - see what we do",
  "contact - get phone and email",
  "You can also ask a normal company question."
].join("\n");

const DIRECT_COMPANY_COMMANDS = new Set([
  "about",
  "company",
  "info",
  "information",
  "services",
  "service",
  "contact",
  "phone",
  "email",
  "location",
  "address",
  "hours",
  "open",
  "pricing",
  "price",
  "cost"
]);

function currentStep(user) {
  return STEPS.find((step) => step.key === user.step) || null;
}

function nextStepKey(stepKey) {
  const index = STEPS.findIndex((step) => step.key === stepKey);
  return STEPS[index + 1]?.key || null;
}

function profileText(user) {
  const profile = user.profile || {};
  return [
    "Saved details:",
    `Name: ${profile.name || "not set"}`,
    `Company/project: ${profile.company || "not set"}`,
    `Need: ${profile.need || "not set"}`
  ].join("\n");
}

function greeting(user, companyName) {
  const name = user.profile?.name ? ` ${user.profile.name}` : "";
  return `Hi${name}. This is ${companyName}. Ask about services, contact, location, hours, or pricing.`;
}

function withOnboardingPrompt(answer, user) {
  const step = currentStep(user);
  if (!step) return answer;
  return `${answer}\n\nTo save your request, ${step.question}`;
}

function looksLikeQuestion(text) {
  return /[?؟]$/.test(text) || /^(what|how|where|when|who|do|does|can|could|is|are)\b/i.test(text);
}

function validateStepAnswer(step, answer) {
  if (answer.length < 2 || /^[^\p{L}\p{N}]+$/u.test(answer)) {
    return `I could not save that. ${step.question}`;
  }

  if (step.key === "need" && answer.length < 5) {
    return "Please describe what you need in a little more detail.";
  }

  return null;
}

function isOnlyPunctuation(text) {
  return /^[^\p{L}\p{N}]+$/u.test(text);
}

function routeMessageResult({ userId, text, store, company }) {
  const incoming = String(text || "").trim();
  const lower = incoming.toLowerCase();
  let response;

  if (!incoming) {
    response = "Please send a text message.";
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false };
  }

  if (lower === "reset") {
    const user = store.resetUser(userId);
    response = currentStep(user).question;
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false, user };
  }

  const user = store.ensureUser(userId);
  const { findCompanyAnswerMatch } = require("./knowledge");

  if (["help", "menu"].includes(lower)) {
    response = withOnboardingPrompt(HELP, user);
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false, user };
  }

  if (lower === "profile") {
    response = profileText(user);
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false, user };
  }

  if (DIRECT_COMPANY_COMMANDS.has(lower)) {
    response = withOnboardingPrompt(findCompanyAnswerMatch(company, incoming).answer, user);
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false, user };
  }

  if (["start", "hi", "hello"].includes(lower)) {
    const step = currentStep(user);
    response = step ? step.question : greeting(user, company.companyName);
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false, user };
  }

  const step = currentStep(user);
  const companyAnswer = findCompanyAnswerMatch(company, incoming);
  if (step?.key === "name" && looksLikeQuestion(incoming) && !isOnlyPunctuation(incoming)) {
    return {
      response: withOnboardingPrompt(companyAnswer.answer, user),
      shouldUseAi: true,
      user
    };
  }

  if (companyAnswer.matched && step?.key === "name" && looksLikeQuestion(incoming)) {
    response = withOnboardingPrompt(companyAnswer.answer, user);
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false, user };
  }

  if (step) {
    const validationError = validateStepAnswer(step, incoming);
    if (validationError) {
      response = validationError;
      store.addHistory(userId, incoming, response);
      return { response, shouldUseAi: false, user };
    }

    const updated = store.updateUser(userId, (draft) => {
      draft.profile[step.key] = incoming;
      draft.step = nextStepKey(step.key);
    });

    const next = currentStep(updated);
    response = next
      ? `Saved. ${next.question}`
      : `Saved. ${profileText(updated)}\n\nNow you can ask me about ${company.companyName}. Type 'help' for commands.`;
    store.addHistory(userId, incoming, response);
    return { response, shouldUseAi: false, user: updated };
  }

  response = companyAnswer.answer;
  if (!companyAnswer.matched) {
    return { response, shouldUseAi: true, user };
  }

  store.addHistory(userId, incoming, response);
  return { response, shouldUseAi: false, user };
}

function routeMessage({ userId, text, store, company }) {
  const result = routeMessageResult({ userId, text, store, company });
  if (result.shouldUseAi) {
    store.addHistory(userId, text, result.response);
  }
  return result.response;
}

module.exports = { routeMessage, routeMessageResult, profileText };
