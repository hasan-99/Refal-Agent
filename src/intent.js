const { detectMessageLanguage } = require("./language");

const INTENTS = Object.freeze({
  GREETING: "greeting",
  SMALL_TALK: "small_talk",
  COMPANY_INFO: "company_info",
  SERVICES: "services",
  CONTACT: "contact",
  REAL_ESTATE: "real_estate",
  LAND_DEVELOPMENT: "land_development",
  CONSTRUCTION: "construction",
  CORPORATE_SERVICES: "corporate_services",
  INVESTMENT: "investment",
  PARTNERSHIP: "partnership",
  APPOINTMENT: "appointment",
  EXISTING_CLIENT: "existing_client",
  COMPLAINT: "complaint",
  LEGAL: "legal",
  TAX: "tax",
  IMMIGRATION: "immigration",
  BANKING: "banking",
  PERMIT: "permit",
  APPROVAL: "approval",
  PRIVACY: "privacy",
  PROMPT_INJECTION: "prompt_injection",
  UNRELATED: "unrelated",
  UNKNOWN: "unknown"
});

const patterns = [
  [INTENTS.PROMPT_INJECTION, /ignore|disregard|override|forget|reveal|show me|system prompt|developer message|تعليمات|التعليمات|تجاهل|تخطى|اكشف|أظهر|كشف|تعليمات النظام|αγνόησε|παράβλεψε|παρακάμψε|αποκάλυψε|εμφάνισε|οδηγίες συστήματος/iu],
  [INTENTS.COMPLAINT, /complaint|complain|unhappy|bad service|refund|شكوى|اشتك|غير راض|سيء|استرداد|παράπονο|καταγγελία|δυσαρεστη/iu],
  [INTENTS.EXISTING_CLIENT, /existing client|my account|my contract|my case|client number|عميل حالي|حسابي|عقدي|ملفي|رقم العميل|υφιστάμενος πελάτης|ο λογαριασμός μου|η υπόθεσή μου/iu],
  [INTENTS.IMMIGRATION, /immigration|visa|residen(?:cy|ce)|citizenship|work permit|مهاجر|هجرة|تأشيرة|فيزا|إقامة|جنسية|άδεια παραμονής|μετανάστευση|βίζα|υπηκοότητα/iu],
  [INTENTS.TAX, /tax|vat|taxation|income tax|ضريبة|ضرائب|ضريبة القيمة|φορολογ|φόρος|φορολογία|φπα/iu],
  [INTENTS.LEGAL, /legal|lawyer|solicitor|law|contract|lawsuit|litigation|قانوني|محامي|محاماة|عقد|دعوى|νομικ|δικηγόρ|σύμβαση|αγωγή/iu],
  [INTENTS.BANKING, /bank|mortgage|loan|financing|finance|credit|bank account|بنك|تمويل|رهن|قرض|حساب بنكي|τραπεζ|στεγαστικό|δάνειο|χρηματοδότηση/iu],
  [INTENTS.PERMIT, /permit|licen[cs]e|planning permission|zoning|رخصة|ترخيص|تصريح|تخطيط|άδεια|πολεοδομ|αδειοδότηση/iu],
  [INTENTS.APPROVAL, /approval|approved|approve|government decision|guarantee(?:d)? approval|موافقة|اعتماد|مقبول|قرار حكومي|έγκριση|εγκριθεί|κρατική απόφαση/iu],
  [INTENTS.INVESTMENT, /invest(?:ment|or|ing)?|portfolio|return|returns|roi|irr|yield|fund|capital|استثمار|مستثمر|محفظة|عائد|عوائد|ربح|رأس المال|επένδυση|επενδυτής|απόδοση|χαρτοφυλάκιο|κεφάλαιο/iu],
  [INTENTS.PARTNERSHIP, /partner(?:ship)?|joint venture|strategic|collaborat|partnership|شراكة|تعاون|مشروع مشترك|استراتيجي|συνεργασία|συνεταιρισμός|κοινή επιχείρηση/iu],
  [INTENTS.LAND_DEVELOPMENT, /land|plot|development|developer|masterplan|أرض|تطوير|مطور|مخطط|οικόπεδο|ανάπτυξη|developer|πολεοδομικό/iu],
  [INTENTS.CONSTRUCTION, /construct|construction|build|building|tender|contractor|مقاول|إنشاء|بناء|مناقصة|εργολάβ|κατασκευ|διαγωνισμός/iu],
  [INTENTS.REAL_ESTATE, /real estate|property|properties|apartment|villa|commercial|rent|buy|sell|عقار|عقارات|شقة|فيلا|تجاري|إيجار|شراء|بيع|ακίνητ|διαμέρισμα|βίλα|ενοικίαση|αγορά/iu],
  [INTENTS.APPOINTMENT, /appointment|meeting|book|schedule|call|visit|availability|موعد|اجتماع|احجز|حجز|اتصال|زيارة|متاح|ραντεβού|συνάντηση|κλείσω|διαθεσιμότητα/iu],
  [INTENTS.CONTACT, /contact|phone|email|where are you|address|reach you|تواصل|هاتف|إيميل|بريد|عنوان|أين|επικοινων|τηλέφων|email|διεύθυνση/iu],
  [INTENTS.CORPORATE_SERVICES, /company formation|company setup|corporate service|business setup|incorporat|تأسيس شركة|خدمات الشركات|إنشاء شركة|تسجيل شركة|ίδρυση εταιρείας|εταιρικές υπηρεσίες/iu],
  [INTENTS.SERVICES, /service|what do you do|what can you help|offer|خدمات|ماذا تقدم|بماذا تساعد|υπηρεσί|τι προσφέρετε|τι κάνετε/iu],
  [INTENTS.COMPANY_INFO, /about refalco|who are you|your company|refalco|ريفالكو|ποια είστε|η εταιρεία σας/iu],
  [INTENTS.SMALL_TALK, /how are you|how's it going|thanks|thank you|شكرا|شكرًا|كيفك|كيف حالك|ευχαριστώ|τι κάνεις|καλά είσαι/iu],
  [INTENTS.GREETING, /^(?:hi|hello|hey|start|مرحبا|مرحبًا|أهلا|اهلا|γεια|καλημέρα|καλησπέρα)[!.؟?\s]*$/iu]
];

const PRIORITY = [INTENTS.PROMPT_INJECTION, INTENTS.COMPLAINT, INTENTS.EXISTING_CLIENT, INTENTS.LEGAL, INTENTS.TAX, INTENTS.IMMIGRATION, INTENTS.BANKING, INTENTS.PERMIT, INTENTS.APPROVAL, INTENTS.INVESTMENT, INTENTS.APPOINTMENT, INTENTS.PARTNERSHIP, INTENTS.CONSTRUCTION, INTENTS.LAND_DEVELOPMENT, INTENTS.REAL_ESTATE, INTENTS.CORPORATE_SERVICES, INTENTS.SERVICES, INTENTS.CONTACT, INTENTS.COMPANY_INFO, INTENTS.SMALL_TALK, INTENTS.GREETING];

function normalizeIntentText(text) {
  return String(text || "").normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/gu, "").replace(/\s+/gu, " ").trim();
}

function detectIntents(text) {
  const value = normalizeIntentText(text);
  const intents = patterns.filter(([, pattern]) => pattern.test(value)).map(([intent]) => intent);
  if (!intents.length) intents.push(value ? INTENTS.UNKNOWN : INTENTS.UNKNOWN);
  return [...new Set(intents)];
}

function detectIntent(text) {
  const intents = detectIntents(text);
  const primary = PRIORITY.find((intent) => intents.includes(intent)) || INTENTS.UNKNOWN;
  return { primary, intents, language: detectMessageLanguage(text), isMultiIntent: intents.length > 1 };
}

module.exports = { INTENTS, INTENT_TAXONOMY: INTENTS, normalizeIntentText, detectIntents, detectIntent, PRIORITY };
