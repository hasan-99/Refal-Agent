function detectMessageLanguage(text) {
  const value = String(text || "").normalize("NFKC");
  const requestedLanguage = detectExplicitLanguageRequest(value);
  if (requestedLanguage) return requestedLanguage;
  const arabicMatches = value.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || [];
  const greekMatches = value.match(/[\u0370-\u03FF\u1F00-\u1FFF]/g) || [];
  const latinMatches = value.match(/[A-Za-z]/g) || [];

  // Detect common Latin-script Syrian Arabic when the user types Arabizi.
  // Require a distinctive dialect word so ordinary English stays English.
  if (!arabicMatches.length && !greekMatches.length && /\b(?:baddi|bade|bdi|shu|shoo|kifak|keefak|3andi|3am|wein|leish|mnih|kwayyis|yalla|wallah|hayda|hayde|mafi|shoghl(?:ha)?|mish|mesh|t2a(?:k|kk)ed|adde|adey|la\s+t2a(?:k|kk)ed)\b/iu.test(value)) {
    return "arabic";
  }

  // Greeklish is common in WhatsApp. These domain and conversational terms
  // are distinctive enough to identify short messages without misclassifying
  // ordinary English.
  if (!arabicMatches.length && !greekMatches.length && /\b(?:thelo|anoikso|etaireia|stin|kypro|yperesies|exete|asxoleitai|rantevou|kostizei|sigouro|poso|akoma|den|exo|gia|ora|xreiaso|epikoinonias|stoicheia|piesis|kleiso|argotera|efharisto|periptosi|diki|sigkrinw|apofasisei|elefthero|kata\d?esi|egkrisi|synithismeno|xroniko|diastima|mexri|kathorisei|teliko|desmeftiko|epivevaiose|anthropos|paketo|perilamvanei|perilambanei|perilamvanetai|perilambanetai|tesseres|mines|grammateia|diefthynsi)\b/iu.test(value)) {
    return "greek";
  }

  const counts = { arabic: arabicMatches.length, greek: greekMatches.length, english: latinMatches.length };
  const strongest = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  if (strongest[0][1] > 0 && strongest[0][1] > strongest[1][1]) return strongest[0][0];
  // Script ties are common in short code-switched messages. Prefer a meaningful
  // non-Latin script, while retaining English as the stable empty/tie default.
  if (counts.arabic > 0 && counts.arabic >= counts.greek && counts.arabic >= counts.english) return "arabic";
  if (counts.greek > 0 && counts.greek >= counts.arabic && counts.greek >= counts.english) return "greek";
  return "english";
}

function detectExplicitLanguageRequest(text) {
  const value = String(text || "").normalize("NFKC");
  if (/\b(?:continue|switch|reply|respond|speak|talk|write)\b.{0,36}\b(?:in\s+)?greek\b|\bgreek\s+(?:please|instead|from now on)\b|στα\s+ελληνικά|στα\s+ελληνικα|να\s+συνεχίσουμε\s+στα\s+ελληνικά/iu.test(value)) return "greek";
  if (/\b(?:continue|switch|reply|respond|speak|talk|write)\b.{0,36}\b(?:in\s+)?arabic\b|\barabic\s+(?:please|instead|from now on)\b|بالعربي|باللغة\s+العربية|نحكي\s+عربي|نكمل\s+عربي|رد\s+عربي/iu.test(value)) return "arabic";
  if (/\b(?:continue|switch|reply|respond|speak|talk|write)\b.{0,36}\b(?:in\s+)?english\b|\benglish\s+(?:please|instead|from now on)\b|στα\s+αγγλικά|στα\s+αγγλικα|(?:بتحكي|بتحكوا|تحكي|تحكوا|بتتكلم|بتتكلموا|تتكلم|تتكلموا|بتحكيلي|احكي|تكلم)\s+(?:بال)?(?:إنجليزي|انجليزي|إنكليزي|انكليزي|الإنجليزية|الانجليزية)|(?:هل\s+)?(?:تجيد|بتعرف|تعرف)\s+(?:اللغة\s+)?(?:الإنجليزية|الانجليزية|إنجليزي|انجليزي|إنكليزي|انكليزي)|μιλά(?:ς|τε)\s+αγγλικά/iu.test(value)) return "english";
  return null;
}

function languageInstruction(language) {
  if (language === "arabic") {
    return "The user's current message is in Arabic. Reply in Arabic using a natural conversational tone; when they write colloquially, use clear, easy Syrian/Levantine Arabic.";
  }

  if (language === "greek") {
    return "The user's current message is in Greek. Reply in natural, professional Greek, keeping the wording simple and readable.";
  }

  return "The user's current message is in English. Reply in English using a natural conversational tone.";
}

function localizedLanguage(language, replies) {
  return replies[language] || replies.english;
}

// BLK-16. Arabic writes the same word several interchangeable ways: `الإقامة`
// and `الاقامة` differ only by the hamza on the alef, and a phone keyboard
// produces either. Matchers that only knew the pointed spelling silently missed
// the bare one — in the safety classifier that was a fail-open, in intent
// detection it is a missed intent.
//
// This lives here, in the leaf language module, because both `safetyPolicy` and
// `intent` need it and neither should depend on the other. It must be applied to
// BOTH sides of a match: to the incoming text, and to the SOURCE of each rule
// pattern. Folding only the text would break every pointed Arabic literal in
// those patterns. The fold rewrites Arabic letters only, never regex syntax, so
// applying it to a pattern source is safe.
const ARABIC_LETTER_FOLDS = Object.freeze([
  [/[أإآٱ]/gu, "ا"], // hamza-carrying and madda alef -> bare alef
  [/ى/gu, "ي"],                     // alef maqsura -> ya
  [/ة/gu, "ه"]                      // ta marbuta -> ha
]);

function foldArabicLetters(text) {
  let value = String(text || "");
  for (const [pattern, replacement] of ARABIC_LETTER_FOLDS) value = value.replace(pattern, replacement);
  return value;
}

// Rebuilds a [key, RegExp] rule table with every pattern source folded, so rules
// stay authored in readable pointed Arabic while matching folded text.
function foldRulePatterns(rules) {
  return rules.map(([key, pattern]) => [key, new RegExp(foldArabicLetters(pattern.source), pattern.flags)]);
}

module.exports = { detectMessageLanguage, detectExplicitLanguageRequest, languageInstruction, localizedLanguage, foldArabicLetters, foldRulePatterns };
