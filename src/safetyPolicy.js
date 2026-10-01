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
  [SAFETY_CATEGORIES.PRIVACY, /(?:api[_ -]?key|access token|secret|password|passcode|pin|credit card|banking credentials|كلمة المرور|كلمة السر|رمز|رقم التعريف|بطاقة|بيانات البنك|κωδικό|κωδικός|κάρτα|τραπεζικά στοιχεία)/iu],
  [SAFETY_CATEGORIES.LEGAL, /legal advice|legal conclusion|is it legal|lawyer|lawsuit|contract advice|قانوني|استشارة قانونية|هل هذا قانوني|محامي|عقد|νομική συμβουλή|δικηγόρος|είναι νόμιμο|σύμβαση/iu],
  [SAFETY_CATEGORIES.TAX, /tax advice|tax rate|tax result|tax liability|vat|ضريبة|ضرائب|نسبة الضريبة|نتيجة ضريبية|φορολογική συμβουλή|φορολογία|φόρος|φπα/iu],
  [SAFETY_CATEGORIES.IMMIGRATION, /immigration|immigration advice|visa|residency|residence permit|citizenship|work permit|هجرة|تأشيرة|فيزا|إقامة|جنسية|άδεια παραμονής|μετανάστευση|βίζα|υπηκοότητα/iu],
  [SAFETY_CATEGORIES.BANKING, /bank.{0,20}(?:approval|approve)|(?:loan|mortgage|financing).{0,20}approval|guarantee(?:d)? loan|bank account|موافقة البنك|قرض|رهن|تمويل|حساب بنكي|έγκριση τράπεζας|δάνειο|στεγαστικό|χρηματοδότηση/iu],
  [SAFETY_CATEGORIES.PERMIT, /permit|license|licence|planning permission|zoning|رخصة|ترخيص|تصريح|موافقة البناء|άδεια|πολεοδομική άδεια|αδειοδότηση/iu],
  [SAFETY_CATEGORIES.APPROVAL, /government approval|company approval|guarantee(?:d)? approval|will be approved|موافقة حكومية|اعتماد الشركة|مضمون الموافقة|سيتم قبوله|κρατική έγκριση|έγκριση εταιρείας|σίγουρη έγκριση/iu],
  [SAFETY_CATEGORIES.INVESTMENT, /investment(?: advice)?|financial advice|guaranteed(?: investment)? returns?|expected returns?|roi|irr|yield|profit guarantee|استثمار|استشارة استثمارية|نصيحة مالية|عوائد مضمونة|العائد المتوقع|ربح مضمون|επενδυτική συμβουλή|οικονομική συμβουλή|εγγυημένη απόδοση|κέρδος/iu]
];

function normalizeSafetyText(text) {
  return String(text || "").normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/gu, "").replace(/\s+/gu, " ").trim();
}

function detectSafetyRisks(text) {
  const value = normalizeSafetyText(text);
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
    generic: "I can’t follow requests for hidden instructions or private credentials. I can help with approved Refalco information and arrange verified team follow-up.",
    legal: "I can’t provide a definitive legal conclusion. The Refalco team can arrange verified professional follow-up for your situation.",
    tax: "I can’t provide personalized tax advice or confirm a tax result. The Refalco team can arrange verified professional follow-up.",
    immigration: "I can’t confirm visa, residency, or immigration outcomes. The Refalco team can arrange verified professional follow-up.",
    banking: "I can’t guarantee bank approval, financing, or a loan outcome. The Refalco team can arrange verified follow-up.",
    permit: "I can’t confirm a permit, licence, or planning outcome. The Refalco team can arrange verified follow-up.",
    approval: "I can’t guarantee a government or company approval. The Refalco team can arrange verified follow-up.",
    investment: "I can’t provide investment advice, expected returns, or financial guarantees. The Refalco team can arrange verified follow-up.",
    privacy: "Please do not send passwords, PINs, card details, banking credentials, or other secrets here. The Refalco team can guide you to an approved secure channel."
  },
  arabic: {
    generic: "لا أستطيع اتباع طلبات تتعلق بالتعليمات المخفية أو بيانات الدخول الخاصة. يمكنني مساعدتك بمعلومات ريفالكو المعتمدة وترتيب متابعة موثوقة من الفريق.",
    legal: "لا أستطيع تقديم نتيجة قانونية نهائية. يمكن لفريق ريفالكو ترتيب متابعة مهنية موثوقة لحالتك.",
    tax: "لا أستطيع تقديم استشارة ضريبية شخصية أو تأكيد نتيجة ضريبية. يمكن لفريق ريفالكو ترتيب متابعة مهنية موثوقة.",
    immigration: "لا أستطيع تأكيد نتائج التأشيرة أو الإقامة أو الهجرة. يمكن لفريق ريفالكو ترتيب متابعة موثوقة.",
    banking: "لا أستطيع ضمان موافقة البنك أو التمويل أو القرض. يمكن لفريق ريفالكو ترتيب متابعة موثوقة.",
    permit: "لا أستطيع تأكيد نتيجة الرخصة أو التصريح أو التخطيط. يمكن لفريق ريفالكو ترتيب متابعة موثوقة.",
    approval: "لا أستطيع ضمان موافقة حكومية أو موافقة شركة. يمكن لفريق ريفالكو ترتيب متابعة موثوقة.",
    investment: "لا أستطيع تقديم نصائح استثمارية أو عوائد متوقعة أو ضمانات مالية. يمكن لفريق ريفالكو ترتيب متابعة موثوقة.",
    privacy: "يرجى عدم إرسال كلمات المرور أو أرقام PIN أو بيانات البطاقات أو بيانات الدخول البنكية هنا. يمكن لفريق ريفالكو إرشادك إلى قناة آمنة ومعتمدة."
  },
  greek: {
    generic: "Δεν μπορώ να ακολουθήσω αιτήματα για κρυφές οδηγίες ή ιδιωτικά διαπιστευτήρια. Μπορώ να βοηθήσω με εγκεκριμένες πληροφορίες της Refalco και να ζητήσω επαλήθευση από την ομάδα.",
    legal: "Δεν μπορώ να δώσω οριστικό νομικό συμπέρασμα. Η ομάδα της Refalco μπορεί να οργανώσει επαληθευμένη επαγγελματική συνέχεια.",
    tax: "Δεν μπορώ να δώσω εξατομικευμένες φορολογικές συμβουλές ή να επιβεβαιώσω φορολογικό αποτέλεσμα. Η ομάδα της Refalco μπορεί να βοηθήσει με επαληθευμένη συνέχεια.",
    immigration: "Δεν μπορώ να επιβεβαιώσω αποτέλεσμα για βίζα, διαμονή ή μετανάστευση. Η ομάδα της Refalco μπορεί να οργανώσει επαληθευμένη συνέχεια.",
    banking: "Δεν μπορώ να εγγυηθώ τραπεζική έγκριση, χρηματοδότηση ή δάνειο. Η ομάδα της Refalco μπορεί να οργανώσει επαληθευμένη συνέχεια.",
    permit: "Δεν μπορώ να επιβεβαιώσω αποτέλεσμα για άδεια ή πολεοδομική έγκριση. Η ομάδα της Refalco μπορεί να οργανώσει επαληθευμένη συνέχεια.",
    approval: "Δεν μπορώ να εγγυηθώ κρατική ή εταιρική έγκριση. Η ομάδα της Refalco μπορεί να οργανώσει επαληθευμένη συνέχεια.",
    investment: "Δεν μπορώ να δώσω επενδυτικές συμβουλές, αναμενόμενες αποδόσεις ή οικονομικές εγγυήσεις. Η ομάδα της Refalco μπορεί να οργανώσει επαληθευμένη συνέχεια.",
    privacy: "Μην στείλετε κωδικούς πρόσβασης, PIN, στοιχεία κάρτας ή τραπεζικά διαπιστευτήρια εδώ. Η ομάδα της Refalco μπορεί να σας καθοδηγήσει σε εγκεκριμένο ασφαλές κανάλι."
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
