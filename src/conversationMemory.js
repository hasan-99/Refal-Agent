const { redactPersonalData } = require("./ai.js");
const { redactSensitiveData } = require("./sensitiveData");
const { isPlausibleCustomerName } = require("./messageRouter.js");
const { classifySafety } = require("./safetyPolicy");

const MAX_RECENT_TURNS = 6;
const MAX_SUMMARY_LENGTH = 700;

function safeMemoryText(value, maxLength = 700) {
  return redactSensitiveData(redactPersonalData(String(value || "")))
    .replace(/\n\s*(?:sources?|المصادر)\s*:\s*[\s\S]*$/iu, "")
    .replace(/https?:\/\/\S+/giu, "[link omitted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function buildCustomerTopicSummary(history = [], currentMessage = "") {
  const customerMessages = (Array.isArray(history) ? history : [])
    .filter((turn) => !turn?.metadata?.safety?.risks?.includes("privacy") && !classifySafety(turn?.message).risks.includes("privacy"))
    .map((turn) => safeMemoryText(turn?.message, 180))
    .filter((message) => message && !isSocialFiller(message));
  const current = classifySafety(currentMessage).risks.includes("privacy") ? "" : safeMemoryText(currentMessage, 180);
  if (current && !isSocialFiller(current)) customerMessages.push(current);

  const unique = [...new Set(customerMessages)].slice(-8);
  if (!unique.length) return "";

  let summary = `Recent topics the customer mentioned: ${unique.join(" | ")}`;
  if (summary.length > MAX_SUMMARY_LENGTH) summary = `${summary.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`;
  return summary;
}

function isSocialFiller(message) {
  return /^(?:hi|hello|hey|thanks|thank you|ok|okay|مرحبا|أهلا|اهلا|كيفك|كيف حالك|تمام|شكرا|شكرًا)[؟?!.،]*$/iu.test(message);
}

function buildConversationContext(user, { currentMessage = "", limit = MAX_RECENT_TURNS } = {}) {
  const profile = user?.profile && typeof user.profile === "object" ? user.profile : {};
  const history = Array.isArray(user?.history) ? user.history : [];
  const recentTurns = history.slice(-Math.max(1, Math.min(MAX_RECENT_TURNS, Number(limit) || MAX_RECENT_TURNS)))
    .filter((turn) => !turn?.metadata?.safety?.risks?.includes("privacy") && !classifySafety(turn?.message).risks.includes("privacy"))
    .flatMap((turn) => {
      const message = safeMemoryText(turn?.message, 600);
      const response = safeMemoryText(turn?.response, 600);
      const result = [];
      if (message) result.push({ role: "user", content: message });
      if (response) result.push({ role: "assistant", content: response });
      return result;
    });

  const clientDetails = [];
  const customerName = safeMemoryText(profile.nameOverride || (isPlausibleCustomerName(profile.name) ? profile.name : ""), 80);
  const customerNeed = safeMemoryText(profile.needOverride || profile.need, 160);
  if (customerName) clientDetails.push(`Customer name: ${customerName}`);
  if (customerNeed) clientDetails.push(`Customer-stated service interest: ${customerNeed}`);
  if (profile.conversationPreferences?.noProactiveBookingOrContact === true) {
    clientDetails.push("Customer preference: do not proactively offer booking, calls, specialist contact, or contact-detail capture; continue answering information questions, and honor any direct customer request for one of those actions.");
  }
  const summary = safeMemoryText(profile.conversationSummary || buildCustomerTopicSummary(history, currentMessage), MAX_SUMMARY_LENGTH);

  return {
    summary: safeMemoryText([summary, ...clientDetails].filter(Boolean).join(" | "), MAX_SUMMARY_LENGTH),
    turns: recentTurns
  };
}

async function refreshCustomerTopicSummary({ store, userId, user, currentMessage }) {
  const summary = buildCustomerTopicSummary(user?.history, currentMessage);
  if (!summary || typeof store?.updateUser !== "function") return summary;
  await store.updateUser(userId, (draft) => {
    draft.profile = draft.profile || {};
    draft.profile.conversationSummary = summary;
    draft.profile.conversationSummaryUpdatedAt = new Date().toISOString();
  });
  return summary;
}

module.exports = {
  MAX_RECENT_TURNS,
  buildCustomerTopicSummary,
  buildConversationContext,
  refreshCustomerTopicSummary,
  safeMemoryText
};
