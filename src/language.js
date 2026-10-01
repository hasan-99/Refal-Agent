function detectMessageLanguage(text) {
  const value = String(text || "").normalize("NFKC");
  const arabicMatches = value.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || [];
  const greekMatches = value.match(/[\u0370-\u03FF\u1F00-\u1FFF]/g) || [];
  const latinMatches = value.match(/[A-Za-z]/g) || [];

  const counts = { arabic: arabicMatches.length, greek: greekMatches.length, english: latinMatches.length };
  const strongest = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  if (strongest[0][1] > 0 && strongest[0][1] > strongest[1][1]) return strongest[0][0];
  // Script ties are common in short code-switched messages. Prefer a meaningful
  // non-Latin script, while retaining English as the stable empty/tie default.
  if (counts.arabic > 0 && counts.arabic >= counts.greek && counts.arabic >= counts.english) return "arabic";
  if (counts.greek > 0 && counts.greek >= counts.arabic && counts.greek >= counts.english) return "greek";
  return "english";
}

function languageInstruction(language) {
  if (language === "arabic") {
    return "The user's current message is in Arabic. Reply in Arabic using a natural conversational tone.";
  }

  if (language === "greek") {
    return "The user's current message is in Greek. Reply in natural, professional Greek.";
  }

  return "The user's current message is in English. Reply in English using a natural conversational tone.";
}

function localizedLanguage(language, replies) {
  return replies[language] || replies.english;
}

module.exports = { detectMessageLanguage, languageInstruction, localizedLanguage };
