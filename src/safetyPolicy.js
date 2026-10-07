const { detectMessageLanguage } = require("./language");

const SAFETY_CATEGORIES = Object.freeze({
  PROMPT_INJECTION: "prompt_injection",
  PRIVACY: "privacy",
  LEGAL: "legal",
  TAX: "tax",
  IMMIGRATION: "immigration",
  BANKING: "banking",
  PERMIT: "permit",
  APPROVAL: "approval",
  INVESTMENT: "investment"
});

const rules = [
  [SAFETY_CATEGORIES.PROMPT_INJECTION, /(?:ignore|disregard|override|forget|bypass|follow only).{0,80}(?:instruction|prompt|rule|system|developer)|(?:reveal|show|print|expose|repeat).{0,80}(?:hidden|system|developer|secret).{0,40}(?:prompt|instruction|message)|(?:تعليمات(?:ي|نا|النظام)?|التعليمات|قواعد النظام).{0,60}(?:تجاهل|تخطى|تجاوز|اتبع)|(?:تجاهل|تخطى|تجاوز).{0,80}(?:التعليمات|القواعد|الرسائل السابقة)|(?:اكشف|أظهر|اعرض|اطبع).{0,80}(?:التعليمات|الموجه|البرومبت|الأسرار)|(?:αγνόησε|παράβλεψε|παρακάμψε).{0,80}(?:οδηγίες|κανόνες|προηγούμενα)|(?:αποκάλυψε|εμφάνισε|δείξε).{0,80}(?:prompt|οδηγίες|μυστικά)/iu],
  [SAFETY_CATEGORIES.PRIVACY, /(?:api[_ -]?key|access token|secret|password|passcode|\bpin\b|credit card|banking credentials|\biban\b|\b(?:otp|one[- ]time (?:password|code)|verification code|cvv|cvc|security code|passport(?: number| no\.?)?|national id(?: number| no\.?)?|identity card(?: number| no\.?)?|account number|bank account)\b\s*(?:is|:|#|=)?\s*[A-Z0-9][A-Z0-9\s-]{2,40}|(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![\p{L}\p{N}])|كلمة المرور|كلمة السر|رمز(?: الدخول| التعريف| التحقق| التأكيد| لمرة واحدة)?|رقم (?:الحساب|الآيبان|الايبان|الجواز|الهوية)|رقم التعريف|بطاقة|بيانات البنك|κωδικό|κωδικός|κάρτα|τραπεζικά στοιχεία|αριθμός (?:λογαριασμού|διαβατηρίου|ταυτότητας))/iu],
  [SAFETY_CATEGORIES.LEGAL, /legal advice|legal conclusion|is it legal|lawyer|lawsuit|contract advice|قانوني|استشارة قانونية|هل هذا قانوني|محامي|عقد|νομική συμβουλή|δικηγόρος|είναι νόμιμο|σύμβαση/iu],
  [SAFETY_CATEGORIES.TAX, /tax advice|tax rate|tax result|tax liability|vat|ضريبة|ضرائب|نسبة الضريبة|نتيجة ضريبية|φορολογική συμβουλή|φορολογία|φόρος|φπα/iu],
  [SAFETY_CATEGORIES.IMMIGRATION, /immigration|immigration advice|visa|residency|residence permit|citizenship|work permit|هجرة|تأشيرة|فيزا|إقامة|جنسية|άδεια παραμονής|μετανάστευση|βίζα|υπηκοότητα/iu],
  [SAFETY_CATEGORIES.BANKING, /bank.{0,20}(?:approval|approve)|(?:loan|mortgage|financing).{0,20}approval|guarantee(?:d)? loan|bank account|موافقة البنك|قرض|رهن|تمويل|حساب بنكي|έγκριση τράπεζας|δάνειο|στεγαστικό|χρηματοδότηση/iu],
  [SAFETY_CATEGORIES.PERMIT, /(?:\b(?:will|would|am i eligible|do i qualify|is it guaranteed|guarantee|confirm).{0,70}\b(?:permit|license|licence|planning permission|zoning)|\b(?:can i get|can i obtain|will i get).{0,50}\b(?:permit|license|licence|planning permission|zoning)|\b(?:permit|license|licence|planning permission|zoning).{0,70}\b(?:approved|granted|eligible|qualify|guaranteed|will i get))|(?:(?:هل سأحصل على|هل يمكنني الحصول على|هل أستحق|هل ستتم الموافقة على|هل تضمن).{0,60}(?:رخصة|ترخيص|تصريح|موافقة البناء)|(?:رخصة|ترخيص|تصريح|موافقة البناء).{0,60}(?:مضمونة|سأحصل|موافقة|مؤهل))|(?:(?:θα εγκριθεί|θα πάρω|είμαι επιλέξιμ|εγγυημένη).{0,60}(?:άδεια|πολεοδομική άδεια|αδειοδότηση)|(?:άδεια|πολεοδομική άδεια|αδειοδότηση).{0,60}(?:έγκριση|επιλεξιμότητα|εγγύηση))/iu],
  [SAFETY_CATEGORIES.APPROVAL, /government approval|company approval|guarantee(?:d)? approval|will be approved|موافقة حكومية|اعتماد الشركة|مضمون الموافقة|سيتم قبوله|κρατική έγκριση|έγκριση εταιρείας|σίγουρη έγκριση/iu],
  // A business mentioning investment is not inherently a request for financial
  // advice. Restrict only advice, recommendations, performance/return claims.
  [SAFETY_CATEGORIES.INVESTMENT, /\b(?:investment\s+(?:advice|recommendations?)|investment.{0,30}(?:returns?|roi|irr|yield)|(?:returns?|roi|irr|yield).{0,30}investment|financial advice|guaranteed(?: investment)? returns?|expected returns?|roi|irr|yield|profit guarantee|recommend(?:ation)?s? (?:about|for) investments?)\b|استشارة استثمارية|نصيحة مالية|توصية استثمارية|عوائد (?:مضمونة|متوقعة)|العائد (?:المتوقع|المضمون)|عوائد الاستثمارية|عوائد استثمارية|ربح مضمون|επενδυτική συμβουλή|οικονομική συμβουλή|εγγυημένη απόδοση|κέρδος/iu]
];

function normalizeSafetyText(text) {
  return String(text || "").normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/gu, "").replace(/\s+/gu, " ").trim();
}

const NON_DISCLOSURE_CLAUSE = /(?:\b(?:(?:i|we|you)\s+)?(?:please\s+)?(?:will not|won't|do not|don't|cannot|can't|never)\s+(?:send|share|give|provide|disclose)\s+(?:a|an|any|my|the)?\s*(?:passwords?|passcodes?|pins?|tokens?|secrets?|credentials?|account(?:\s+numbers?)?|ibans?|otps?|cvvs?|passports?(?:\s+numbers?)?|card details?)\b[^.!?؟;؛]*|(?:ما\s*رح|لن|لا\s+أريد|ما\s+بدي|مو\s+رح|مش\s+رح)\s*(?:أرسل|ارسل|أشارك|شارك|أعطي|اعطي|أبعث|ابعث)\s*(?:أي|كلمة|كلمات|رمز|رموز|بيانات)?\s*(?:(?:كلمة|كلمات)\s+المرور|(?:كلمة|كلمات)\s+السر|رموز?(?:\s+الدخول|\s+التحقق)?|بيانات\s+(?:الدخول|الاعتماد|البنك)|رقم\s+الحساب)[^.!?؟;؛]*|(?:δεν\s+θα|δεν\s+θέλω\s+να|μην)\s*(?:στείλω|μοιραστώ|δώσω|κοινοποιήσω)\s*(?:κανένα|κανέναν|κωδικό(?:ς|υς)?|διαπιστευτήρια|στοιχεία)?\s*(?:κωδικό(?:ς|υς)?|διαπιστευτήρια|στοιχεία\s+σύνδεσης|κάρτα|τραπεζικά\s+στοιχεία|αριθμό\s+λογαριασμού)[^.!?؟;؛]*)/giu;

function removeNonDisclosureMentions(text) {
  return String(text || "").replace(NON_DISCLOSURE_CLAUSE, (clause) => {
    if (/(?:passwords?|passcodes?|pins?|tokens?|secrets?|credentials?|account(?:\s+numbers?)?|ibans?|otps?|cvvs?|passports?(?:\s+numbers?)?|card details?|(?:كلمة|كلمات)\s+المرور|(?:كلمة|كلمات)\s+السر|رموز?(?:\s+الدخول|\s+التحقق)?|بيانات\s+(?:الدخول|الاعتماد|البنك)|رقم\s+الحساب|κωδικό(?:ς|υς)?|διαπιστευτήρια|στοιχεία\s+σύνδεσης|κάρτα|αριθμό\s+λογαριασμού)\s*(?:is|:|=|هو|هي|είναι)?\s*(?!\[redacted\])(?!(?:and|or|nor|but|here|there|with|to|now|any|my|the|a|an|و|أو|او|لكن|بس|معي|και|ή|αλλά|εδώ|εκεί)\b)[\p{L}\p{N}][\p{L}\p{N}._!@#$%^&*-]{2,}/iu.test(clause)) return clause;
    return " ";
  });
}

function detectSafetyRisks(text) {
  const value = normalizeSafetyText(removeNonDisclosureMentions(text));
  return [...new Set(rules.filter(([, pattern]) => pattern.test(value)).map(([category]) => category))];
}

function classifySafety(text) {
  const risks = detectSafetyRisks(text);
  return { safe: risks.length === 0, restricted: risks.length > 0, risks, primary: risks[0] || null, language: detectMessageLanguage(text) };
}

function isPromptInjection(text) { return detectSafetyRisks(text).includes(SAFETY_CATEGORIES.PROMPT_INJECTION); }
function isRestrictedTopic(text) { return detectSafetyRisks(text).some((risk) => risk !== SAFETY_CATEGORIES.PROMPT_INJECTION); }

const FALLBACKS = Object.freeze({
  english: {
    generic: "I can’t follow requests for hidden instructions or private credentials. I can help with approved the business information.",
    legal: "I can’t provide a definitive legal conclusion; that depends on your situation and needs qualified review.",
    tax: "I can’t provide personalized tax advice or confirm a tax result; that depends on your circumstances and needs qualified review.",
    immigration: "I can’t confirm visa, residency, or immigration outcomes; these depend on your circumstances and official decisions.",
    banking: "I can’t guarantee bank approval, financing, or a loan outcome; the bank makes that decision.",
    permit: "I can’t confirm a permit, licence, or planning outcome; it depends on the relevant authority’s review.",
    approval: "I can’t guarantee a government or company approval; the relevant decision-maker must confirm it.",
    investment: "I can’t provide investment advice, expected returns, or financial guarantees.",
    privacy: "Please do not send passwords, PINs, card details, banking credentials, or other secrets here. Use an approved secure channel for those details."
  },
  arabic: {
    generic: "ما فيني أتبع طلبات تكشف التعليمات المخفية أو بيانات الدخول الخاصة. فيني ساعدك بمعلومات الشركة المعتمدة.",
    legal: "ما فيني أعطي حكم قانوني نهائي؛ هالشي بيعتمد على تفاصيل حالتك وبدّه مراجعة مختص.",
    tax: "ما فيني أعطي استشارة ضريبية شخصية أو أكد نتيجة ضريبية؛ هالشي بيعتمد على ظروفك وبدّه مراجعة مختص.",
    immigration: "ما فيني أكد نتيجة فيزا أو إقامة أو هجرة؛ هالقرارات بتعتمد على حالتك والجهة الرسمية.",
    banking: "ما فيني أضمن موافقة البنك أو التمويل أو القرض؛ القرار بيرجع للبنك.",
    permit: "ما فيني أكد نتيجة رخصة أو تصريح أو تخطيط؛ لازم الجهة المختصة تراجع الطلب.",
    approval: "ما فيني أضمن موافقة حكومية أو موافقة شركة؛ لازم الجهة المسؤولة تأكدها.",
    investment: "ما فيني أعطي نصيحة استثمارية أو عوائد متوقعة أو ضمانات مالية.",
    privacy: "يرجى عدم إرسال كلمات المرور أو أرقام PIN أو بيانات البطاقات أو بيانات الدخول البنكية هون. استخدم قناة آمنة ومعتمدة لهالمعلومات."
  },
  greek: {
    generic: "Δεν μπορώ να ακολουθήσω αιτήματα για κρυφές οδηγίες ή ιδιωτικά διαπιστευτήρια. Μπορώ να βοηθήσω με εγκεκριμένες πληροφορίες της the business.",
    legal: "Δεν μπορώ να δώσω οριστικό νομικό συμπέρασμα· εξαρτάται από τα στοιχεία της περίπτωσής σας και χρειάζεται αξιολόγηση ειδικού.",
    tax: "Δεν μπορώ να δώσω εξατομικευμένες φορολογικές συμβουλές ή να επιβεβαιώσω φορολογικό αποτέλεσμα· εξαρτάται από την περίπτωσή σας και χρειάζεται αξιολόγηση ειδικού.",
    immigration: "Δεν μπορώ να επιβεβαιώσω αποτέλεσμα για βίζα, διαμονή ή μετανάστευση· εξαρτάται από την περίπτωσή σας και την αρμόδια αρχή.",
    banking: "Δεν μπορώ να εγγυηθώ τραπεζική έγκριση, χρηματοδότηση ή δάνειο.",
    permit: "Δεν μπορώ να επιβεβαιώσω αποτέλεσμα για άδεια ή πολεοδομική έγκριση· απαιτείται αξιολόγηση από την αρμόδια αρχή.",
    approval: "Δεν μπορώ να εγγυηθώ κρατική ή εταιρική έγκριση· πρέπει να την επιβεβαιώσει ο αρμόδιος φορέας.",
    investment: "Δεν μπορώ να δώσω επενδυτικές συμβουλές, αναμενόμενες αποδόσεις ή οικονομικές εγγυήσεις.",
    privacy: "Μην στείλετε κωδικούς πρόσβασης, PIN, στοιχεία κάρτας ή τραπεζικά διαπιστευτήρια εδώ. Χρησιμοποιήστε εγκεκριμένο ασφαλές κανάλι για αυτά τα στοιχεία."
  }
});

function safeLocalizedFallback(textOrCategory, language) {
  const explicitCategory = Object.values(SAFETY_CATEGORIES).includes(textOrCategory);
  const category = explicitCategory ? textOrCategory : classifySafety(textOrCategory).primary;
  const lang = FALLBACKS[language] ? language : detectMessageLanguage(textOrCategory);
  const key = category === SAFETY_CATEGORIES.PROMPT_INJECTION ? "generic" : category || "generic";
  return FALLBACKS[lang][key] || FALLBACKS[lang].generic;
}

module.exports = { SAFETY_CATEGORIES, normalizeSafetyText, detectSafetyRisks, classifySafety, isPromptInjection, isRestrictedTopic, safeLocalizedFallback, FALLBACKS };
