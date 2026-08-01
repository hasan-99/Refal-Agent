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
  "Commands:",
  "start - begin or continue",
  "profile - show your saved details",
  "reset - clear your saved details",
  "services - see what we do",
  "contact - get phone and email",
  "You can also ask a normal company question."
].join("\n");

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

function routeMessage({ userId, text, store, company }) {
  const incoming = String(text || "").trim();
  const lower = incoming.toLowerCase();
  let response;

  if (!incoming) {
    response = "Please send a text message.";
    store.addHistory(userId, incoming, response);
    return response;
  }

  if (lower === "reset") {
    const user = store.resetUser(userId);
    response = currentStep(user).question;
    store.addHistory(userId, incoming, response);
    return response;
  }

  const user = store.ensureUser(userId);

  if (["help", "menu"].includes(lower)) {
    response = HELP;
    store.addHistory(userId, incoming, response);
    return response;
  }

  if (lower === "profile") {
    response = profileText(user);
    store.addHistory(userId, incoming, response);
    return response;
  }

  if (["start", "hi", "hello"].includes(lower)) {
    const step = currentStep(user);
    response = step ? step.question : greeting(user, company.companyName);
    store.addHistory(userId, incoming, response);
    return response;
  }

  const step = currentStep(user);
  if (step) {
    const updated = store.updateUser(userId, (draft) => {
      draft.profile[step.key] = incoming;
      draft.step = nextStepKey(step.key);
    });

    const next = currentStep(updated);
    response = next
      ? `Saved. ${next.question}`
      : `Saved. ${profileText(updated)}\n\nNow you can ask me about ${company.companyName}. Type 'help' for commands.`;
    store.addHistory(userId, incoming, response);
    return response;
  }

  const { findCompanyAnswer } = require("./knowledge");
  response = findCompanyAnswer(company, incoming);
  store.addHistory(userId, incoming, response);
  return response;
}

module.exports = { routeMessage, profileText };
