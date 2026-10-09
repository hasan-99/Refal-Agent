const { detectMessageLanguage, foldArabicLetters, foldRulePatterns } = require("./language");

const INTENTS = Object.freeze({
  GREETING: "greeting",
  SMALL_TALK: "small_talk",
  AGENT_IDENTITY: "agent_identity",
  COMPANY_INFO: "company_info",
  BUSINESS_AREAS: "business_areas",
  PRICING: "pricing",
  SERVICES: "services",
  CONTACT: "contact",
  COMPANY_FORMATION: "company_formation",
  ACCOUNTING: "accounting",
  VAT: "vat",
  CYPRUS_BUSINESS_EXPANSION: "cyprus_business_expansion",
  BUSINESS_RELOCATION: "business_relocation",
  RESIDENCY_ENQUIRY: "residency_enquiry",
  REAL_ESTATE_PURCHASE: "real_estate_purchase",
  REAL_ESTATE_INVESTMENT: "real_estate_investment",
  LAND_OWNER: "land_owner",
  PROPERTY_DEVELOPMENT: "property_development",
  CONSTRUCTION_TENDER: "construction_tender",
  PROJECT_MANAGEMENT: "project_management",
  INVESTMENT_OPPORTUNITY: "investment_opportunity",
  INVESTMENT_PARTNERSHIP: "investment_partnership",
  STRATEGIC_PARTNERSHIP: "strategic_partnership",
  INFRASTRUCTURE: "infrastructure",
  TECHNOLOGY: "technology",
  OPERATIONS: "operations",
  STRATEGIC_ASSETS: "strategic_assets",
  BUSINESS_PROPOSAL: "business_proposal",
  PROJECT_ENQUIRY: "project_enquiry",
  SUPPLIER: "supplier",
  CAREER: "career",
  MEDIA: "media",
  GENERAL_INFORMATION: "general_information",
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

// BLK-16, second half. The safety classifier was fixed first because its gap was
// a fail-open; this one is a missed intent, so a bare-alef speller got a worse
// answer rather than an unsafe one. Both halves now share one fold.
const rawPatterns = [
  [INTENTS.PROMPT_INJECTION, /ignore|disregard|override|forget|reveal|show me|system prompt|developer message|تعليمات|التعليمات|تجاهل|تخطى|اكشف|أظهر|كشف|تعليمات النظام|αγνόησε|παράβλεψε|παρακάμψε|αποκάλυψε|εμφάνισε|οδηγίες συστήματος/iu],
  [INTENTS.COMPLAINT, /complaint|complain|unhappy|bad service|refund|\bstill upset\b|\bupset about\b|\bfrustrated with\b|شكوى|اشتك|غير راض|سيء|استرداد|لسا زعلان|لسا متضايق|مو راضي|مو راضية|παράπονο|καταγγελία|δυσαρεστη|ακόμα αναστατωμ/iu],
  // Route only a real account/case support request into verification. A
  // hypothetical “my case” in a service or outcome question (or a refusal to
  // share account details) must not trap the customer in the verification
  // flow. Explicit existing-client statements and account status/update
  // requests remain covered in all supported languages.
  [INTENTS.EXISTING_CLIENT, /\b(?:existing client|i(?:'m| am) an? existing client|as an? existing client|client number|customer number|account (?:status|balance|issue|problem|update|reference|number)|(?:status|update|issue|problem|progress|reference|number) (?:of|for|on) my (?:account|contract|case)|my (?:account|contract|case) (?:status|issue|problem|update|number|reference)|help with my (?:account|contract|case))\b|عميل\s+حالي|رقم\s+(?:العميل|الحساب)|(?:حسابي|عقدي|ملفي).{0,30}(?:مشكلة|حالة|تحديث|رقم|متابعة|استفسار)|(?:مشكلة|حالة|تحديث|متابعة|استفسار).{0,30}(?:حسابي|عقدي|ملفي)|υφιστάμενος πελάτης|(?:κατάσταση|ενημέρωση|πρόβλημα|αριθμός|αναφορά)\s+(?:του\s+)?(?:λογαριασμού|συμβολαίου|υπόθεσής)\s+μου|(?:ο\s+)?(?:λογαριασμός|συμβόλαιο|υπόθεσή)\s+μου.{0,30}(?:κατάσταση|ενημέρωση|πρόβλημα|αριθμός|αναφορά)/iu],
  [INTENTS.COMPANY_FORMATION, /company formation|company setup|set up a company|incorporat|register(?:ing)? (?:an? )?(?:investment )?company|(?:بدي|اريد|أريد|حابب|حابة)\s+(?:اسجل|أسجل|أسس|أؤسس|افتح|أفتح)\s+(?:لي\s+)?(?:شركة|شركه)|(?:اسجل|أسجل|تسجيل|تأسيس|تاسيس|إنشاء)\s+(?:شركة|شركه)(?:\s+(?:استثمار|استثمارية|تجارية|تقنية|عقارية))?|شركة\s+استثمارية|ίδρυση εταιρείας|σύσταση εταιρείας/iu],
  [INTENTS.PRICING, /\b(?:how much|price|prices|pricing|cost|costs|fee|fees|quote|quotation)\b|كم\s+(?:(?:ال)?تكلفة|يكلف|(?:ال)?سعر|الأسعار)|تكلفة تأسيس|رسوم (?:تأسيس|إنشاء)|قديش\s+(?:(?:ال)?تكلفة|رسوم|(?:ال)?سعر)|(?:χρεώσ|τιμές|τιμή|εκτιμώμεν|κόστος ίδρυσης|πόσο κοστίζει)|πακέτ.{0,55}(?:περίπτω|δεδομέν|σίγουρ|επιβεβαιώ|χρέω|τιμ)|\bposo\s+kostizei\b|\bti\s+(?:timi|times|kostos)\b|\b(?:timi|timh|times|ektimisi|kostos|poso)\b|\b(?:paketo|perilamvanei|perilambanei|perilamvanetai|perilambanetai|mesa\s+sto)\b.{0,45}\b(?:paketo|perilamvanei|perilambanei|perilamvanetai|perilambanetai|999|tesseres\s+mines)\b|\b(?:perilamvanei|perilambanei|perilamvanetai|perilambanetai|mesa\s+sto)\b.{0,35}\b\d{2,}\b|\b\d{2,}\b.{0,55}\b(?:perilamvanei|perilambanei|perilamvanetai|perilambanetai|kostos|timi|timh|times|ektimisi|epipleon|xehoro|isxyoun|isxyei|epivevaiose|anthropos|teliko|desmeftiko|periptosi|kathorisei)\b/iu],
  [INTENTS.ACCOUNTING, /account(?:ing|ancy)|bookkeeping|financial statements|محاسب|محاسبة|مسك الدفاتر|λογιστ(?:ική|ής)|τήρηση βιβλίων/iu],
  [INTENTS.VAT, /\bvat\b|value added tax|ضريبة القيمة المضافة|ضريبة القيمة|φπα|φόρος προστιθέμενης αξίας/iu],
  [INTENTS.CYPRUS_BUSINESS_EXPANSION, /(?:business|company|corporate) expansion|expand(?:ing)? (?:to|in) cyprus|توسع (?:تجاري|الشركة)|توسعة الأعمال|επέκταση επιχειρηματικής δραστηριότητας|επέκταση στην κύπρο/iu],
  [INTENTS.BUSINESS_RELOCATION, /business relocation|relocate (?:my )?(?:business|company)|move (?:my )?(?:business|company)|نقل (?:النشاط|الشركة)|نقل الأعمال|μετεγκατάσταση επιχείρησης|μεταφορά εταιρείας/iu],
  [INTENTS.RESIDENCY_ENQUIRY, /residency|residence permit|residence status|إقامة|الإقامة|άδεια παραμονής|διαμονή|καθεστώς διαμονής/iu],
  [INTENTS.REAL_ESTATE_PURCHASE, /(?:buy|purchase|acquire|looking for) (?:a |an )?(?:property|home|apartment|villa|house)|شراء (?:عقار|منزل|شقة|فيلا)|αγορά (?:ακινήτου|διαμερίσματος|βίλας|κατοικίας)/iu],
  [INTENTS.REAL_ESTATE_INVESTMENT, /(?:real estate|property) investment|invest(?:ing)? in (?:a |an )?(?:property|real estate|apartment|villa)|استثمار (?:عقاري|في العقارات)|επένδυση σε ακίνητα|επένδυση σε ακίνητο/iu],
  [INTENTS.LAND_OWNER, /landowner|land owner|i own land|my plot|مالك أرض|أملك أرضا|أملك أرضًا|ιδιοκτήτης γης|έχω οικόπεδο/iu],
  [INTENTS.PROPERTY_DEVELOPMENT, /property development|develop(?:ing)? (?:a |the )?(?:property|plot|land)|تطوير عقاري|تطوير أرض|ανάπτυξη ακινήτου|ανάπτυξη οικοπέδου/iu],
  [INTENTS.CONSTRUCTION_TENDER, /construction tender|building tender|request for tender|مناقصة (?:بناء|إنشاء)|مناقصة إنشاءات|διαγωνισμός κατασκευής/iu],
  [INTENTS.PROJECT_MANAGEMENT, /project management|manage (?:the )?project|إدارة المشاريع|إدارة المشروع|διαχείριση έργου|διαχείριση έργων/iu],
  [INTENTS.INVESTMENT_OPPORTUNITY, /investment opportunity|investment proposal|opportunity to invest|فرصة استثمارية|عرض استثماري|επενδυτική ευκαιρία|επενδυτική πρόταση/iu],
  [INTENTS.INVESTMENT_PARTNERSHIP, /investment partnership|partner(?:ship)? to invest|شراكة استثمارية|شراكة للاستثمار|επενδυτική συνεργασία/iu],
  [INTENTS.STRATEGIC_PARTNERSHIP, /strategic partnership|strategic partner|شراكة استراتيجية|شريك استراتيجي|στρατηγική συνεργασία|στρατηγικός εταίρος/iu],
  [INTENTS.INFRASTRUCTURE, /infrastructure|infrastructure project|بنية تحتية|مشروع بنية تحتية|υποδομή|έργο υποδομής/iu],
  [INTENTS.TECHNOLOGY, /technology|tech services|digital transformation|تقنية|تكنولوجيا|التحول الرقمي|τεχνολογία|ψηφιακός μετασχηματισμός/iu],
  [INTENTS.OPERATIONS, /operations|operational support|business operations|العمليات|التشغيل|إدارة العمليات|λειτουργίες|επιχειρησιακή υποστήριξη/iu],
  [INTENTS.STRATEGIC_ASSETS, /strategic assets?|special assets?|أصول استراتيجية|الأصول الاستراتيجية|στρατηγικά περιουσιακά στοιχεία/iu],
  [INTENTS.BUSINESS_PROPOSAL, /business proposal|commercial proposal|business offer|مقترح تجاري|اقتراح عمل|πρόταση επιχειρηματικής συνεργασίας|εμπορική πρόταση/iu],
  [INTENTS.PROJECT_ENQUIRY, /\b(?:project|business idea)\b.{0,60}\b(?:cyprus|uncertain|not sure|fit|suitable)\b|(?:فكرة مشروع|مشروع).{0,50}(?:بقبرص|في قبرص|قبرص)|(?:έργο|επιχειρηματική ιδέα).{0,50}(?:Κύπρο|Κύπρος|αβέβαι)/iu],
  [INTENTS.SUPPLIER, /supplier|vendor enquiry|become a supplier|مورد|توريد|أصبح موردا|أصبح موردًا|προμηθευτής|προμηθευτές/iu],
  [INTENTS.CAREER, /career|careers|job|jobs|vacancy|work for (?:business|refal(?:co)?(?: group)?)|وظيفة|وظائف|توظيف|عمل لدى|καριέρα|θέση εργασίας|εργασία στη(?:ν)? (?:business|refal(?:co)?(?: group)?)/iu],
  [INTENTS.MEDIA, /media enquiry|press enquiry|journalist|journalists|interview request|استفسار إعلامي|صحفي|صحافة|مقابلة إعلامية|δημοσιογράφος|μέσα ενημέρωσης|συνέντευξη/iu],
  [INTENTS.AGENT_IDENTITY, /^(?:(?:hi|hello|hey|مرحبا|مرحبًا|أهلا|اهلا|γεια(?:\s+σας)?)[,،\s]*)?(?:who are you(?:\s+and what do you do)?|who is this|what are you|what do you do|tell me who you are|about you|مين (?:أنت|انت)(?:\s+وشو بتعمل(?:وا)?)?|من (?:أنت|انت)|شو بتعمل(?:وا)?|ποιος είστε|ποια είστε|ποιοι είστε(?:\s+και τι κάνετε)?|ποιος είσαι|ποια είσαι|ποιο είσαι|τι είσαι|τι είστε)[?!.؟;؛\s]*$/iu],
  [INTENTS.BUSINESS_AREAS, /\b(?:what|which|tell me about|describe)\b.{0,70}\b(?:business areas?|areas? of (?:focus|activity|operation)|sectors?|industr(?:y|ies)|platforms?|lines of business|business scope|focus areas?)\b|(?:business areas?|areas? of focus|sectors?|industr(?:y|ies)|platforms?|lines of business|business scope).{0,70}\b(?:business|refal(?:co)?(?: group)?|your (?:business|company)|you|focus|operate|cover|work)\b|(?:ما|ما هي|أي|في أي|ما أبرز).{0,60}(?:مجالات العمل|مجالات الأعمال|مجالات نشاط|نطاق الأعمال|قطاعات|منصات)|(?:مجالات العمل|مجالات الأعمال|مجالات نشاط|نطاق الأعمال|قطاعات|منصات).{0,60}(?:الشركة|تعمل|تركز|نشاط|نطاق)|(?:σε ποιους|σε ποιες|ποιοι|ποιους|ποια).{0,65}(?:τομείς|κλάδους|επιχειρηματικ|πλατφόρμες|δραστηριότητες)|(?:τομείς δραστηριότητας|επιχειρηματικοί τομείς|κλάδοι δραστηριότητας|πλατφόρμες).{0,60}(?:business|refal(?:co)?(?: group)?|εταιρεία|εστιάζ|δραστηριοποι)|(?:με τι ασχολείται|με τι ασχολείστε|τι δραστηριότητα έχει|ποιο είναι το αντικείμενο(?: της)? δραστηριότητας).{0,65}(?:business|refal(?:co)?(?: group)?|η εταιρεία|ο όμιλος|η ομάδα)|(?:τι κάνει|τι δραστηριότητες έχει).{0,50}(?:η business|refal(?:co)?(?: group)?|ο όμιλος|η εταιρεία)/iu],
  [INTENTS.GENERAL_INFORMATION, /general information|information about (?:business|refal(?:co)?(?: group)?)|معلومات عامة|استفسار عام|γενικές πληροφορίες|γενική ενημέρωση/iu],
  [INTENTS.IMMIGRATION, /immigration|visa|residen(?:cy|ce)|citizenship|work permit|مهاجر|هجرة|تأشيرة|فيزا|إقامة|جنسية|άδεια παραμονής|μετανάστευση|βίζα|υπηκοότητα/iu],
  [INTENTS.TAX, /tax|vat|taxation|income tax|ضريبة|ضرائب|ضريبة القيمة|φορολογ|φόρος|φορολογία|φπα/iu],
  [INTENTS.LEGAL, /legal|lawyer|solicitor|law|contract|lawsuit|litigation|قانوني|محامي|محاماة|عقد|دعوى|νομικ|δικηγόρ|σύμβαση|αγωγή/iu],
  [INTENTS.BANKING, /bank|mortgage|loan|financing|finance|credit|bank account|بنك|تمويل|رهن|قرض|حساب بنكي|τραπεζ|στεγαστικό|δάνειο|χρηματοδότηση/iu],
  [INTENTS.PERMIT, /permit|licen[cs]e|planning permission|zoning|رخصة|ترخيص|تصريح|تخطيط|άδεια|πολεοδομ|αδειοδότηση/iu],
  [INTENTS.APPROVAL, /approval|approved|approve|government decision|guarantee(?:d)? approval|موافقة|اعتماد|مقبول|قرار حكومي|έγκριση|εγκριθεί|κρατική απόφαση/iu],
  [INTENTS.INVESTMENT, /invest(?:ment|or|ing)?|portfolio|return|returns|roi|irr|yield|fund|capital|استثمار|مستثمر|محفظة|عائد|عوائد|ربح|رأس المال|επένδυση|επενδυτής|απόδοση|χαρτοφυλάκιο|κεφάλαιο/iu],
  [INTENTS.PARTNERSHIP, /partner(?:ship)?|joint venture|strategic|collaborat|partnership|شراكة|تعاون|مشروع مشترك|استراتيجي|συνεργασία|συνεταιρισμός|κοινή επιχείρηση/iu],
  [INTENTS.LAND_DEVELOPMENT, /land|plot|development|developer|masterplan|أرض|تطوير|مطور|مخطط|οικόπεδο|ανάπτυξη|developer|πολεοδομικό/iu],
  [INTENTS.CONSTRUCTION, /construct|construction|build|building|tender|contractor|مقاول|إنشاءات|إنشاء (?:مبنى|مبانٍ|مشروع|مرافق)|بناء|مناقصة|εργολάβ|κατασκευ|διαγωνισμός/iu],
  [INTENTS.REAL_ESTATE, /real estate|property|properties|apartment|villa|commercial|rent|sell|عقار|عقارات|شقة|فيلا|تجاري|إيجار|بيع|ακίνητ|διαμέρισμα|βίλα|ενοικίαση/iu],
  // "book"/"call"/"visit" are wrapped in \b so they only match as whole words
  // (with common inflections) and not as substrings of unrelated words such
  // as "bookkeeping", "recall", "textbook", or "visitor".
  [INTENTS.APPOINTMENT, /appointment|meeting|\bbook(?:s|ing|ed)?\b|schedule|\bcall(?:s|ing|ed)?\b|\bvisit(?:s|ing|ed)?\b|availability|موعد|اجتماع|احجز|حجز|اتصال|زيارة|متاح|ραντεβού|συνάντηση|κλείσω|διαθεσιμότητα/iu],
  [INTENTS.CONTACT, /contact|phone|email|where are you|address|reach you|تواصل|هاتف|إيميل|بريد|عنوان|أين|επικοινων|τηλέφων|email|διεύθυνση/iu],
  [INTENTS.CORPORATE_SERVICES, /corporate service|corporate services|business setup|خدمات الشركات|الخدمات المؤسسية|εταιρικές υπηρεσίες/iu],
  [INTENTS.SERVICES, /service|what do you do|what can you help|offer|خدمات|ماذا تقدم|شو بتقدموا|شو بتقدم|بماذا تساعد|υπηρεσί|τι προσφέρετε|τι κάνετε/iu],
  [INTENTS.COMPANY_INFO, /about (?:business|refal(?:co)?(?: group)?)|who are you|your company|what is (?:business|refal(?:co)?(?: group)?)|الشركة|مين (?:أنت|انت)|من (?:أنت|انت)|شو بتعمل(?:وا)?|شو (?:هي|هيه) الشركة|ما هي الشركة|ποιος είστε|ποια είστε|ποιοι είστε|η εταιρεία σας|τι είναι η (?:business|refal(?:co)?(?: group)?)/iu],
  [INTENTS.SMALL_TALK, /how are you|how's it going|thanks|thank you|شكرا|شكرًا|كيفك|كيف حالك|ευχαριστώ|τι κάνεις|καλά είσαι/iu],
  [INTENTS.GREETING, /^(?:(?:hi|hello|hey)(?: there)?|start|مرحبا|مرحبًا|أهلا|اهلا|السلام عليكم|γεια(?:\s+σας)?|καλημέρα|καλησπέρα)(?:[،,\s]+(?:who are you|what do you do|شو بتعمل|مين (?:أنت|انت)|ما عملكم|ما هي خدماتكم))?[!.؟?\s]*$/iu]
];

const PRIORITY = [INTENTS.PROMPT_INJECTION, INTENTS.COMPLAINT, INTENTS.EXISTING_CLIENT, INTENTS.LEGAL, INTENTS.TAX, INTENTS.IMMIGRATION, INTENTS.BANKING, INTENTS.PERMIT, INTENTS.APPROVAL, INTENTS.COMPANY_FORMATION, INTENTS.INVESTMENT, INTENTS.PRICING, INTENTS.APPOINTMENT, INTENTS.PARTNERSHIP, INTENTS.PROJECT_ENQUIRY, INTENTS.CONSTRUCTION, INTENTS.LAND_DEVELOPMENT, INTENTS.REAL_ESTATE, INTENTS.CORPORATE_SERVICES, INTENTS.BUSINESS_AREAS, INTENTS.AGENT_IDENTITY, INTENTS.SERVICES, INTENTS.CONTACT, INTENTS.COMPANY_INFO, INTENTS.SMALL_TALK, INTENTS.GREETING];

const patterns = foldRulePatterns(rawPatterns);

function normalizeIntentText(text) {
  return foldArabicLetters(
    String(text || "").normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/gu, "").replace(/\s+/gu, " ").trim()
  );
}

function detectIntents(text) {
  const value = normalizeIntentText(text);
  const intents = patterns.filter(([, pattern]) => pattern.test(value)).map(([intent]) => intent);
  if (intents.includes(INTENTS.APPOINTMENT) && explicitlyDeclinesMeeting(value)) {
    intents.splice(intents.indexOf(INTENTS.APPOINTMENT), 1);
  }
  if (!intents.length) intents.push(value ? INTENTS.UNKNOWN : INTENTS.UNKNOWN);
  return [...new Set(intents)];
}

// Folded for the same reason as `patterns`: this runs against already-folded
// text, so its Arabic literals (`حابة`, `بدي`) would stop matching otherwise.
const [, DECLINES_MEETING] = foldRulePatterns([["declines",
  /(?:\b(?:do not|don't|dont|not ready(?: yet)?|not currently|not now|no|without|rather not)\b.{0,45}\b(?:book|schedule|meeting|call|appointment)\b|\b(?:meeting|call|appointment)\b.{0,25}\b(?:not now|not yet|not currently)\b|ما\s+بدي.{0,45}(?:احجز|حجز|موعد|اجتماع)|لا.{0,30}(?:موعد|اجتماع|احجز|حجز)|مو\s+حابة.{0,30}(?:موعد|اجتماع)|δεν\s+(?:θέλω|χρειάζομαι|επιθυμώ).{0,45}(?:ραντεβού|συνάντηση|κλήση))/iu]])[0];

function explicitlyDeclinesMeeting(text) {
  return DECLINES_MEETING.test(text);
}

function detectIntent(text) {
  const intents = detectIntents(text);
  const primary = PRIORITY.find((intent) => intents.includes(intent)) || INTENTS.UNKNOWN;
  return { primary, intents, language: detectMessageLanguage(text), isMultiIntent: intents.length > 1 };
}

module.exports = { INTENTS, INTENT_TAXONOMY: INTENTS, normalizeIntentText, detectIntents, detectIntent, PRIORITY };
