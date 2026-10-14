"use strict";

const RESPONSE_STYLE_DEFAULTS = Object.freeze({
  paragraphLength: "short",
  listMarker: "hyphen",
  boldLabels: true,
  continuationStyle: "adaptive",
  allowRelevantServiceSuggestions: true
});

function validateResponseStyle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Response style must be an object.");
  }
  const allowed = new Set(["paragraphLength", "listMarker", "boldLabels", "continuationStyle", "allowRelevantServiceSuggestions"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Response style contains an unsupported setting.");
  }
  const paragraphLength = value.paragraphLength ?? RESPONSE_STYLE_DEFAULTS.paragraphLength;
  const listMarker = value.listMarker ?? RESPONSE_STYLE_DEFAULTS.listMarker;
  const boldLabels = value.boldLabels ?? RESPONSE_STYLE_DEFAULTS.boldLabels;
  const continuationStyle = value.continuationStyle ?? RESPONSE_STYLE_DEFAULTS.continuationStyle;
  const allowRelevantServiceSuggestions = value.allowRelevantServiceSuggestions ?? RESPONSE_STYLE_DEFAULTS.allowRelevantServiceSuggestions;
  if (!["short", "very_short"].includes(paragraphLength)) throw new TypeError("Choose a supported paragraph length.");
  if (!["hyphen", "numbered"].includes(listMarker)) throw new TypeError("Choose a supported list marker.");
  if (typeof boldLabels !== "boolean") throw new TypeError("Bold labels must be enabled or disabled.");
  if (!["adaptive", "useful_question", "helpful_next_step"].includes(continuationStyle)) throw new TypeError("Choose a supported conversation continuation style.");
  if (typeof allowRelevantServiceSuggestions !== "boolean") throw new TypeError("Related service suggestions must be enabled or disabled.");
  return Object.freeze({ paragraphLength, listMarker, boldLabels, continuationStyle, allowRelevantServiceSuggestions });
}

function responseStyleInstruction(value) {
  const style = validateResponseStyle(value || RESPONSE_STYLE_DEFAULTS);
  const paragraph = style.paragraphLength === "very_short"
    ? "Keep paragraphs especially concise, while retaining every useful condition."
    : "Keep paragraphs short and separate them with a blank line.";
  const list = style.listMarker === "numbered"
    ? "When a list helps, use a numbered list with each item on its own line."
    : "When a list helps, use hyphen bullets with each item on its own line.";
  const labels = style.boldLabels
    ? "Use the channel's supported bold style sparingly for short labels only."
    : "Do not use bold styling.";
  const continuation = {
    adaptive: "When useful to continue the conversation, add one concise, specific next-step question or helpful piece of information. Skip this when the answer stands on its own; never add a generic offer or force a question.",
    useful_question: "When one missing detail would move the customer's goal forward, ask at most one specific follow-up question on its own final line. Skip it when the answer stands on its own; never force a question or use a generic offer.",
    helpful_next_step: "When useful, add one concise, specific next action or relevant information after the answer. Ask a question only when clarification is needed. Skip this when the answer stands on its own; never add a generic offer."
  }[style.continuationStyle];
  const serviceSuggestions = style.allowRelevantServiceSuggestions
    ? "After answering, you may add at most one related service suggestion only when it directly helps the customer's stated goal and current approved evidence supports it. It is optional; respect declines, sensitive situations, lead-tier limits, and prior interest boundaries."
    : "Do not add unsolicited related-service suggestions, cross-sell hooks, or benefit hints. Still answer all service details the customer requested, and respect safety, evidence, lead-tier, and prior-interest rules.";
  return `Administrator response preferences: ${paragraph} ${list} ${labels} ${continuation} ${serviceSuggestions} These preferences never override safety, accuracy, approved evidence, or appointment rules.`;
}

module.exports = { RESPONSE_STYLE_DEFAULTS, validateResponseStyle, responseStyleInstruction };
