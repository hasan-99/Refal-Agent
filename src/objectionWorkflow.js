const CATEGORIES = Object.freeze([
  "price", "trust", "timing", "competitor", "tax", "bureaucracy", "risk", "uncertainty", "partner_consultation", "not_ready"
]);

const PATTERNS = Object.freeze({
  price: /\b(?:too expensive|expensive|overpriced|cheaper|too costly|can't afford|cannot afford|outside (?:my|our) budget|price is (?:high|too much))\b|(?:السعر|التكلفة|التكاليف|الرسوم).{0,20}(?:غالي|مرتفعة|كثيرة|مبالغ)|(?:غالي|مرتفعة|مبالغ).{0,20}(?:السعر|التكلفة|الرسوم)|(?:ακριβό|υπερβολικό κόστος|εκτός προϋπολογισμού)/i,
  trust: /\b(?:trust|reliable|reputation|proof|scam|legitimate|reviews)\b|ثقة|موثوق|احتيال|سمعة|αξιοπιστία|εμπιστοσύνη|απάτη/i,
  timing: /\b(?:later|wait|timing|time|deadline|busy|next month|not now)\b|لاحقًا|انتظر|الوقت|ليس الآن|αργότερα|χρόνος|όχι τώρα/i,
  competitor: /\b(?:i(?:'m| am) (?:choosing|going with)|i prefer)\s+(?:the\s+)?(?:other|another|competitor|provider|firm)\b|(?:سأختار|بفضّل|أفضل)\s+(?:شركة|المنافس|الجهة)\s+(?:الأخرى|الثانية)|(?:θα επιλέξω|προτιμώ)\s+(?:την άλλη εταιρεία|άλλον πάροχο)/i,
  tax: /\b(?:i (?:won't|will not|can't|cannot) proceed because of|tax(?:es)? are too high for me|i am worried about)\b.{0,35}\b(?:tax|vat|fiscal)\b|(?:ما بدي|لن أتابع بسبب|قلقان من).{0,30}(?:الضريبة|الضرائب|ضريبة القيمة)|(?:δεν θα προχωρήσω λόγω|ανησυχώ για).{0,35}(?:φόρο|φορολογ)/iu,
  bureaucracy: /\b(?:too much paperwork|i (?:don't|do not|won't|will not|can't|cannot) want to deal with the paperwork|red tape is a deal.?breaker)\b|(?:ما بدي أتعامل مع|الأوراق كتيرة علي|الإجراءات معقدة بالنسبة إلي)|(?:δεν θέλω να ασχοληθώ με τη γραφειοκρατία|η χαρτούρα είναι υπερβολική)/iu,
  risk: /\b(?:too risky for me to proceed|i won't proceed because of the risk|the risk is a deal.?breaker)\b|(?:المخاطر كتيرة بالنسبة إلي|ما رح تابع بسبب المخاطر)|(?:είναι πολύ ριψοκίνδυνο για μένα|δεν θα προχωρήσω λόγω του κινδύνου)/iu,
  uncertainty: /\b(?:not sure (?:i want to|whether to) proceed|unclear whether i should proceed|confused about whether to proceed)\b|(?:مو متأكد إذا بدي تابع|محتار إذا لازم تابع)|(?:δεν είμαι σίγουρος αν θα προχωρήσω|δεν ξέρω αν πρέπει να συνεχίσω)/iu,
  partner_consultation: /\b(?:partner|spouse|husband|wife|team|board|discuss with|consult)\b|شريك|زوج|زوجة|فريق|مجلس|أستشير|σύντροφος|σύζυγ|ομάδα|συζητήσω/i,
  not_ready: /\b(?:not ready|maybe later|just looking|just browsing|no decision|not interested yet|still comparing|comparing options|haven't chosen|have not chosen|not committed|no commitment)\b|لست مستعد|ربما لاحقًا|مجرد استفسار|لم أقرر|لسا عم قارن|لسا بقارن|عم قارن الخيارات|مو مقرر(?:ة)?|δεν είμαι έτοιμ|ίσως αργότερα|απλώς κοιτάζω|συγκρίνω ακόμη|δεν έχω αποφασίσει|\bden\s+exo\s+apofasisei\b|\bsigkrinw\s+epiloges\b/iu
});

function detectObjection(text) {
  const value = String(text || "");
  const categories = CATEGORIES.filter((category) => PATTERNS[category].test(value));
  return { isObjection: categories.length > 0, category: categories[0] || null, categories };
}

function objectionResponse({ text = "", language = "en" } = {}) {
  const detected = detectObjection(text);
  const category = detected.category || "uncertainty";
  const key = String(language).toLowerCase().slice(0, 2);
  const nextQuestion = {
    en: "What would help you make the next decision?",
    ar: "ما الذي سيساعدك على اتخاذ الخطوة التالية؟",
    el: "Τι θα σας βοηθούσε να αποφασίσετε το επόμενο βήμα;"
  }[key] || "What would help you make the next decision?";
  return {
    ...detected,
    category,
    nextQuestion,
    fallback: true,
    safe: true,
    responseData: { category, language: key, deterministic: true }
  };
}

module.exports = { CATEGORIES, PATTERNS, detectObjection, classifyObjection: detectObjection, objectionResponse };
