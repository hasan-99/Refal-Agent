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

function deriveContinuedLookupRequest(currentMessage, recentConversation = []) {
  const current = String(currentMessage || "").normalize("NFKC").trim();
  const turns = Array.isArray(recentConversation) ? recentConversation : [];
  const assistant = [...turns].reverse().find((turn) => turn?.role === "assistant");
  const user = [...turns].reverse().find((turn) => turn?.role === "user");
  if (!assistant || !user || turns.indexOf(user) > turns.indexOf(assistant)) return null;

  const affirmative = /^(?:yes|yeah|sure|okay|ok|please|go ahead|do that|نعم|اي|إي|أكيد|اكيد|تمام|من فضلك|لو سمحت|ναι|βεβαίως|βεβαιως|φυσικά|φυσικα|παρακαλώ|παρακαλω)(?:[\s,.،!؟؛;]|$)/iu.test(current);
  if (!affirmative) return null;

  const offer = String(assistant.content || "").normalize("NFKC");
  const englishOffer = /\b(?:i can|i could|let me)\b.{0,100}\b(?:look\s+up|check|search|find\s+out|verify|confirm)\b.{0,100}\b(?:if you(?:'d| would) like|if you want|if helpful)\b|\b(?:look\s+up|check|search|find\s+out|verify|confirm)\b.{0,100}\b(?:if you(?:'d| would) like|if you want|if helpful)\b/iu.test(offer);
  const arabicOffer = /(?:فيني|يمكنني|أستطيع|استطيع).{0,100}(?:ابحث|أبحث|دور|تحقق|تأكد|شوف|راجع).{0,100}(?:إذا|لو|إن).{0,30}(?:تحب|بدك|أردت|رغبت)|(?:ابحث|أبحث|دور|تحقق|تأكد|شوف|راجع).{0,100}(?:إذا|لو|إن).{0,30}(?:تحب|بدك|أردت|رغبت)/u.test(offer);
  const greekOffer = /(?:μπορώ|μπορουμε|μπορούμε|να σας).{0,100}(?:ελέγξω|ψάξω|αναζητήσω|επιβεβαιώσω|ελέγξουμε).{0,100}(?:αν θέλετε|αν το θέλετε|εφόσον θέλετε)/iu.test(offer);
  const request = String(user.content || "").trim();
  return (englishOffer || arabicOffer || greekOffer) && request ? request.slice(0, 1000) : null;
}

module.exports = { deriveOpenQuestion, deriveContinuedLookupRequest };
