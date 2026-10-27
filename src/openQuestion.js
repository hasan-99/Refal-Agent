"use strict";

// Re-derive the most recent assistant question from the persisted reply. The
// result is continuity context only; callers must keep it untrusted and must
// never use it as evidence for company facts or as authorization for actions.
function deriveOpenQuestion(lastTurn) {
  // The customer-facing answer may end with one of the calibrated persona
  // emoji. Strip only REFAL's permitted emoji before checking whether the last
  // sentence is a question, so that emoji do not break short-answer continuity.
  const response = String(lastTurn?.response || "")
    .replace(/(?:\s*(?:😄|👀|👍|😂|🙌|✨))+\s*$/u, "")
    .trim();
  if (!response) return null;

  // Only treat a question at the end of the reply as outstanding. Greek uses
  // a semicolon as its question mark; other semicolons inside a reply do not
  // matter unless they are the final punctuation.
  const end = response.match(/[?؟;](?=[\s"'”»)]*$)/u);
  if (!end) return null;
  const endIndex = end.index;
  const prefix = response.slice(0, endIndex);
  const boundary = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf("؟"), prefix.lastIndexOf(";"));
  const question = response.slice(boundary + 1, endIndex + 1).trim();
  return question ? question.slice(0, 300) : null;
}

module.exports = { deriveOpenQuestion };
