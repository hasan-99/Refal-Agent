const { localizedLanguage, foldArabicLetters, foldRulePatterns } = require("./language");
const { requestsForbiddenCredential, CREDENTIAL_KINDS } = require("./privacyHardRule");

// P2.5 / W2.5.6 — Source of Funds and Source of Wealth (MB-SEC3).
//
// MB-SEC3 asks for two things at once: explain BOTH documentation requirements,
// and explain them SEPARATELY, "without terrifying the customer". Those pull in
// opposite directions, so the wording below is deliberately neutral and
// procedural. It describes what each term means and why it is asked, with no
// warning language, no consequence language, and no suggestion that the
// customer is under suspicion. Compliance is normal, and it reads as normal.
//
// The English and Arabic and Greek Source of Funds wordings are the approved
// MB-F35 / MB-F37 candidates MBC-010 and MBC-011 in src/brainMbCandidates.js,
// used verbatim so the two surfaces cannot drift. Source of Wealth has no
// approved candidate yet, so it is authored here in the same register.
//
// Only HIGH LEVEL STATUS in chat. Never files, never statements. The outbound
// gate below enforces the second half of that sentence.

const SOURCE_OF_FUNDS = Object.freeze({
  english: "Source of Funds is the direct path of the amount used in this specific transaction, such as a transfer from a personal bank account. Banks and immigration authorities require documentation of the Source of Funds as a normal standard compliance step.",
  arabic: "مصدر الأموال هو المسار المباشر للمبلغ المستخدم بهالمعاملة تحديداً، متل تحويل من حساب بنكي شخصي. البنوك وسلطات الهجرة بتطلب توثيق مصدر الأموال كخطوة امتثال عادية ومعيارية.",
  greek: "Η Πηγή Κεφαλαίων είναι η άμεση διαδρομή του ποσού που χρησιμοποιείται σε αυτή τη συγκεκριμένη συναλλαγή, όπως μεταφορά από προσωπικό τραπεζικό λογαριασμό. Οι τράπεζες και οι αρχές μετανάστευσης απαιτούν τεκμηρίωση της Πηγής Κεφαλαίων ως συνηθισμένο τυπικό βήμα συμμόρφωσης."
});

const SOURCE_OF_WEALTH = Object.freeze({
  english: "Source of Wealth is the wider picture of how your overall wealth was built over time, for example a business you own, income from employment over several years, an inheritance, or the sale of a property. It looks at the whole background rather than at one single payment.",
  arabic: "مصدر الثروة هو الصورة الأوسع لكيفية بناء ثروتك عبر الوقت، متل شركة بتملكها، أو دخل من الوظيفة عبر سنين، أو إرث، أو بيع عقار. بينظر للخلفية الكاملة مش لدفعة وحدة.",
  greek: "Η Πηγή Πλούτου είναι η ευρύτερη εικόνα του πώς δημιουργήθηκε ο συνολικός σας πλούτος με την πάροδο του χρόνου, για παράδειγμα μια επιχείρηση που σας ανήκει, εισόδημα από εργασία για αρκετά χρόνια, μια κληρονομιά ή η πώληση ενός ακινήτου. Κοιτάζει το συνολικό υπόβαθρο και όχι μία μεμονωμένη πληρωμή."
});

// The separation line, plus the chat boundary. Said once, calmly.
const SEPARATION = Object.freeze({
  english: "They are two separate questions and they are answered with two separate sets of documents. Here in chat we only discuss the high level status of your file. Documents and statements are never sent here, they go through an approved secure channel.",
  arabic: "هني سؤالين منفصلين، وبينجاوب عليهن بمجموعتين منفصلتين من المستندات. هون بالمحادثة منحكي بس عن الحالة العامة لملفك. المستندات وكشوفات الحساب ما بتنبعت هون، بتمر عبر قناة آمنة ومعتمدة.",
  greek: "Είναι δύο ξεχωριστά ερωτήματα και απαντώνται με δύο ξεχωριστά σύνολα εγγράφων. Εδώ στη συνομιλία συζητάμε μόνο τη γενική κατάσταση του φακέλου σας. Έγγραφα και αντίγραφα κίνησης δεν στέλνονται εδώ, περνούν μέσα από εγκεκριμένο ασφαλές κανάλι."
});

function explainSourceOfFunds(language = "english") {
  return localizedLanguage(language, SOURCE_OF_FUNDS);
}

function explainSourceOfWealth(language = "english") {
  return localizedLanguage(language, SOURCE_OF_WEALTH);
}

function explainBothSeparately(language = "english") {
  return [
    explainSourceOfFunds(language),
    explainSourceOfWealth(language),
    localizedLanguage(language, SEPARATION)
  ].join("\n\n");
}

// Documents beyond the bank statement that privacyHardRule already covers.
// Every alternative needs a request verb, so explaining what a payslip is stays
// allowed while asking for one does not (BLK-15, no unanchored substrings).
const EN_REQUEST = "(?:send|sending|share|sharing|provide|providing|give|giving|upload|attach|forward|email|scan|i need|we need|please supply|supply|can you send)";
const AR_REQUEST = "(?:أرسل|ارسل|ابعت|ابعتلي|بعتلي|شاركني|أعطني|اعطني|أعطيني|اعطيني|زودني|زوّدني|ارفع|أرفق|ارفق|بحاجة|نحتاج|لازم ترسل)";
const EL_REQUEST = "(?:στείλτε|στείλε|μοιραστείτε|δώστε|δώσε|ανεβάστε|επισυνάψτε|προωθήστε|σαρώστε|χρειάζομαι|χρειαζόμαστε|μπορείτε να στείλετε)";

const rawDocumentRules = [
  ["sensitive_financial_document", new RegExp([
    `\\b${EN_REQUEST}\\b[^.!?]{0,35}\\b(?:pay ?slips?|salary slips?|salary certificates?|tax returns?|tax declarations?|audited accounts|financial statements?|proof of income|income statements?|bank statements?|account statements?|statement of account)\\b`,
    `${AR_REQUEST}[^.!?؟]{0,35}(?:قسيمة الراتب|كشف الراتب|شهادة راتب|الإقرار الضريبي|إقرار ضريبي|البيانات المالية|القوائم المالية المدققة|إثبات الدخل|كشف الحساب|كشف حساب|كشوفات الحساب)`,
    `${EL_REQUEST}[^.!?;]{0,35}(?:εκκαθαριστικό|βεβαίωση αποδοχών|φορολογική δήλωση|μισθοδοσία|οικονομικές καταστάσεις|αποδεικτικό εισοδήματος|τραπεζικό αντίγραφο|κίνηση λογαριασμού|κινήσεις λογαριασμού)`
  ].join("|"), "iu")]
];

const documentRules = foldRulePatterns(rawDocumentRules);

function normalizeDocumentText(text) {
  return foldArabicLetters(
    String(text || "").normalize("NFKC").replace(/[ً-ٰٟـ]/gu, "").replace(/\s+/gu, " ").trim()
  );
}

/**
 * W2.5.6 outbound gate — is REFAL asking for a sensitive financial document in
 * chat? Reuses the bank statement kind from privacyHardRule rather than keeping
 * a second copy of it, and adds the payslip and tax return family on top.
 */
function requestsSensitiveFinancialDocument(text) {
  const value = normalizeDocumentText(text);
  if (!value) return false;
  if (requestsForbiddenCredential(text).kinds.includes(CREDENTIAL_KINDS.BANK_STATEMENT)) return true;
  return documentRules.some(([, pattern]) => pattern.test(value));
}

module.exports = {
  SOURCE_OF_FUNDS,
  SOURCE_OF_WEALTH,
  SEPARATION,
  explainSourceOfFunds,
  explainSourceOfWealth,
  explainBothSeparately,
  requestsSensitiveFinancialDocument
};
