function detectMessageLanguage(text) {
  const value = String(text || "").normalize("NFKC");
  const requestedLanguage = detectExplicitLanguageRequest(value);
  if (requestedLanguage) return requestedLanguage;
  const arabicMatches = value.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || [];
  const greekMatches = value.match(/[\u0370-\u03FF\u1F00-\u1FFF]/g) || [];
  const latinMatches = value.match(/[A-Za-z]/g) || [];

  // A transliterated cue can also be a Latin-script proper name ("Poio is a
  // project code", "Shou is a family name"). Mask only that token when an
  // English copula/article frame occurs in the same clause. Keep the
  // remaining text in the language signal so separate Arabic/Greeklish
  // clauses still classify the whole message. Raw script counts above remain
  // untouched.
  const languageSignalValue = value.replace(
    /\b(?:poia|poio|poios|shou)\b(?=[^.!?؟;;\n]{0,80}\b(?:is|was|are|were)\s+(?:a|an|the)\b)/giu,
    (token) => " ".repeat(token.length)
  );

  // Detect common Latin-script Syrian Arabic when the user types Arabizi.
  // Require a distinctive dialect word so ordinary English stays English.
  if (!arabicMatches.length && !greekMatches.length && /\b(?:baddi|bade|bdi|shu|shoo|shou|kifak|keefak|3andi|3and(?:kon|kom|kum|on|om|um)|3am|wein|leish|mnih|kwayyis|yalla|wallah|hayda|hayde|mafi|shoghl(?:ha)?|barmeje|mish|mesh|t2a(?:k|kk)ed|adde|adey|la\s+t2a(?:k|kk)ed|tasees|ta.?sis|sharike|sherke|dareebe|darayeb|muhasabe|muhasaba|iqame|i.?qame|3aqar|3a.?qar|mashroo3|masareef|bankiye|mowazzaf|mowazafeen|bta3m(?:el|lo)|bte2dar(?:o)?|min\s+wen|ayya|masari|rasse?\s+mal|mashari3|sharike\s+jadide)\b/iu.test(languageSignalValue)) {
    return "arabic";
  }

  // Greeklish is common in WhatsApp. These domain and conversational terms
  // are distinctive enough to identify short messages without misclassifying
  // ordinary English.
  if (!arabicMatches.length && !greekMatches.length && /\b(?:thelo|anoikso|etaireia|stin|kypro|yperesies|exete|poia|poio|poios|diadikasia|diadikasies|kostos|asxoleitai|rantevou|kostizei|sigouro|poso|akoma|exo|gia|ora|xreiaso|epikoinonias|stoicheia|piesis|kleiso|argotera|efharisto|periptosi|diki|sigkrinw|apofasisei|elefthero|kata\d?esi|egkrisi|synithismeno|xroniko|diastima|mexri|kathorisei|teliko|desmeftiko|epivevaiose|anthropos|paketo|perilamvanei|perilambanei|perilamvanetai|perilambanetai|tesseres|mines|grammateia|diefthynsi|ftiaxno|efarmogi|logismiko|foros|forolog(?:ia|ikos|iki|iko)|akinito|enoikio|trapeza|etaireikos|logistiki|adeia|adeia\s+diamoni(?:s)?|adeia\s+paramonis|monimi\s+diamoni|monimos\s+katoikos|metanastefsi|epixeirisi|epixeirimatiko|systasi|idioktisia|akinita|metox(?:os|oi)|diacheirist(?:is|ria)|eforia|merism(?:a|ata)|oikoped(?:o|ou)|diamerisma|katoikia|enoikiasi|polikatoikia|periousia|agora\s+akinitou|polisi\s+akinitou|nai|ti\s+(?:einai|simenei))\b/iu.test(languageSignalValue)) {
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
  if (/\b(?:continue|switch|reply|respond|answer|speak|talk|write)\b.{0,36}\b(?:in\s+)?greek\b|\b(?:explain|describe|tell|translate)\b.{0,36}\b(?:in|into|to)\s+greek\b|\bgreek\s+(?:please|instead|from now on)\b|στα\s+ελληνικ(?:ά|α)|να\s+συνεχίσουμε\s+στα\s+ελληνικ(?:ά|α)|στα\s+ελληνικα/iu.test(value)) return "greek";
  if (/\b(?:apantise|grapse|milise|synexise)\s+(?:sta\s+)?ellinika\b|(?:احكي|اكتب|رد|جاوب)(?:ني)?(?:\s+(?:لي|علي|معي))?\s*(?:بال)?(?:يوناني|اليوناني)/iu.test(value)) return "greek";
  if (/\b(?:continue|switch|reply|respond|answer|write)\b.{0,36}\b(?:in\s+)?english\b|\b(?:explain|describe|tell|translate)\b.{0,36}\b(?:in|into|to)\s+english\b|\benglish\s+(?:please|instead|from now on)\b|στα\s+αγγλικ(?:ά|α)|(?:γράψε|γραψε|απάντησε|απαντησε|μίλα|μιλα)\s+στα\s+αγγλικ(?:ά|α)|(?:احكي|اكتب|رد|جاوب)(?:ني)?(?:\s+(?:لي|علي|معي))?\s*(?:بال)?(?:إنجليزي|انجليزي|إنكليزي|انكليزي|الإنجليزية|الانجليزية)/iu.test(value)) return "english";
  if (/\b(?:continue|switch|reply|respond|answer|speak|talk|write)\b.{0,36}\b(?:in\s+)?arabic\b|\b(?:explain|describe|tell|translate)\b.{0,36}\b(?:in|into|to)\s+arabic\b|\barabic\s+(?:please|instead|from now on)\b|بالعربي|باللغة\s+العربية|نحكي\s+عربي|نكمل\s+عربي|رد\s+عربي|(?:احكي|اكتب|رد|جاوب)(?:ني)?(?:\s+(?:لي|علي|معي))?\s*(?:بال)?(?:عربي|العربية)/iu.test(value)) return "arabic";
  if (/στα\s+αραβικ(?:ά|α)|(?:γράψε|γραψε|απάντησε|απαντησε|μίλα|μιλα)\s+στα\s+αραβικ(?:ά|α)/iu.test(value)) return "arabic";
  if (/στα\s+ελληνικ(?:ά|α)|(?:γράψε|γραψε|απάντησε|απαντησε|μίλα|μιλα)\s+στα\s+ελληνικ(?:ά|α)/iu.test(value)) return "greek";
  if (/\b(?:apantise|grapse|milise|synexise)\s+(?:sta\s+)?(?:agglika|ellinika|aravika)\b/iu.test(value)) {
    const requested = value.match(/\b(?:apantise|grapse|milise|synexise)\s+(?:sta\s+)?(agglika|ellinika|aravika)\b/iu)?.[1]?.toLowerCase();
    return requested === "ellinika" ? "greek" : requested === "aravika" ? "arabic" : "english";
  }
  return null;
}

function languageInstruction(language) {
  if (language === "arabic") {
    return "The user's current message is in Arabic. Reply in warm, clear Arabic; when they write colloquially, use accessible Syrian/Levantine Arabic. Keep legal and government wording simple and professional.";
  }

  if (language === "greek") {
    return "The user's current message is in Greek. Reply in natural, professional business Greek, keeping the wording simple and readable.";
  }

  return "The user's current message is in English. Reply in clear, natural English and mirror the formality of their message: relaxed when they are casual, concise and professional when they are formal. Stay warm and practical without sounding stiff or overly legalistic.";
}

function localizedLanguage(language, replies) {
  return replies[language] || replies.english;
}

function inboundRetryMessage(language, kind = "unavailable") {
  const messages = {
    unavailable: {
      arabic: "أواجه مشكلة مؤقتة في التحقق من رسالتك. يرجى المحاولة بعد قليل.",
      english: "I’m having trouble checking your message right now. Please try again shortly.",
      greek: "Αντιμετωπίζω προσωρινό πρόβλημα με τον έλεγχο του μηνύματός σας. Παρακαλώ δοκιμάστε ξανά σε λίγο."
    },
    busy: {
      arabic: "أتعامل مع عدة رسائل الآن. يرجى إعادة إرسال رسالتك بعد قليل.",
      english: "I’m handling several messages at the moment. Please resend your message shortly.",
      greek: "Εξυπηρετώ αρκετά μηνύματα αυτή τη στιγμή. Παρακαλώ στείλτε ξανά το μήνυμά σας σε λίγο."
    }
  };
  return localizedLanguage(language, messages[kind] || messages.unavailable);
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

module.exports = { detectMessageLanguage, detectExplicitLanguageRequest, languageInstruction, localizedLanguage, inboundRetryMessage, foldArabicLetters, foldRulePatterns };
