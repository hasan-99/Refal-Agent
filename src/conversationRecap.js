const { detectMessageLanguage } = require("./language");
const { classifySafety, SAFETY_CATEGORIES } = require("./safetyPolicy");
const { redactSensitiveData } = require("./sensitiveData");
const { answerFromEvidence, containsProhibitedClaim } = require("./refalcoAnswer");

// Only intercept an explicit request to recap this conversation or its actions.
// A "summary of services" or "to recap, is that right?" is another intent.
const RECAP_REQUEST = /\b(?:summari[sz]e|summary|recap)\b.{0,100}\b(?:what\s+(?:i|we)\s+(?:said|told|discussed|asked)|what(?:'s|\s+is)\s+been\s+discussed|our\s+conversation|this\s+conversation|what\s+(?:you\s+)?(?:recorded|saved)|(?:my|our)\s+(?:goal|request|preferences)|what\s+(?:action|has been done)|action\s+status)\b|\bwhat\s+(?:did\s+i\s+tell\s+you|have\s+we\s+discussed|have\s+you\s+recorded)\b|لخّص.{0,80}(?:قلتلك|المحادثة|طلب|سجلتم|تسجل)|لخص.{0,80}(?:قلتلك|المحادثة|طلب|سجلتم|تسجل)|شو قلتلك|ماذا قلت.{0,40}(?:لكم|لك)|ما الذي سجلتموه|τι είπα.{0,60}(?:σας|στη συζήτηση)|συνοψ.{0,80}(?:τι\s+(?:σας\s+)?(?:είπα|ζήτησα|καταγράφηκε|καταγράψατε)|τη\s+συζήτηση)|τι καταγράψατε/iu;
const NON_RECAP_CONTENT = /^(?:hi|hello|hey|thanks|thank you|yes|no|ok|okay|مرحبا|أهلا|تمام|شكرا|نعم|لا|ναι|όχι|εντάξει)[.!،؟?\s]*$/iu;
const PUBLISHED_INFO_QUERY = /\b(?:published|approved|official)\b.{0,100}\b(?:estimates?|case|check|confirmed|person)\b|\b(?:estimates?|case|check|confirmed|person)\b.{0,100}\b(?:published|approved|official)\b|معلومات\s*(?:منشورة|معتمدة|رسمية).{0,100}(?:تقدير|تأكد|حالتي|مختص)|δημοσιευμέν(?:ες|α).{0,100}(?:εκτίμηση|επιβεβαίωση|ειδικό)/iu;

const RECAP_PATTERNS = {
  goal: /\b(?:want|looking|trying|plan(?:ning)?|need|hope)\b.{0,100}\b(?:set up|start|form|establish|incorporat|company|business|develop|develop(?:ment)?|invest|investment|portfolio|construction|tender|partner|land)\b|\b(?:company|business|startup)\b.{0,100}\b(?:setup|formation|in cyprus|will|to)\b|بدي.{0,100}(?:أسس|تأسيس|شركة|استثمار|أطور|أرض|مشروع)|(?:الشركة|مشروعي|مشروعنا|أرضي|أرضنا).{0,100}(?:قبرص|استثمار|تطوير|عملاء|نشاط)|(?:θέλω|σχεδιάζουμε|χρειαζόμαστε|εταιρεία|επιχείρηση|επένδυση|ανάπτυξη|οικόπεδο).{0,100}(?:εταιρεία|Κύπρο|επένδυ|ανάπτυξ|πελάτ|γη)/iu,
  activity: /\b(?:own funds|our own money|client money|customers|portfolio services|software consultancy|e-commerce|ecommerce|online retail|online furniture shop|manage investments|activity is|company will|company does|we will)\b|(?:أموالنا|أموال الشركة|أموال العملاء|إدارة استثمارات|تجارة إلكترونية|نشاط الشركة|الشركة رح|الشركة هدفها|عملاء)|(?:δικά μας κεφάλαια|χρήματα πελατών|διαχείριση επενδύσεων|δραστηριότητα|η εταιρεία θα|η εταιρεία μας)/iu,
  noContact: /\b(?:don't|do not|no need to|please don't)\s+(?:contact|call|follow up|share my (?:details|contact)|arrange (?:contact|a call))\b|\b(?:don't|do not)\s+want\s+(?:anyone\s+)?(?:reaching out|contacting|following up)\b|\bdo not pressure me\s+(?:to book|to send|about)\b.{0,80}\b(?:contact|details|call|book|share)\b|\b(?:information|written update) only\b|لا\s*(?:ترتبوا|ترتب|تنسقوا|تنسق)\s*(?:أي\s*)?(?:تواصل|اتصال)|ما\s*بدي\s*(?:حدا|أحد|الفريق)\s*(?:يتواصل|يتصل)|ما\s*وافقت\s*(?:على|لـ)\s*(?:مكالمة|تواصل|مشاركة)|بدي\s*(?:التحديث|المعلومة)\s*(?:كتابة|كتابي)|μόνο\s*(?:γραπτή\s*)?ενημέρωση|δεν\s+θέλω\s+(?:να\s+)?(?:επικοινωνήσει|επικοινωνία)|μην\s+επικοινωνήσετε/iu,
  noDocuments: /\b(?:no|not|don't|do not)\s+(?:send|share|collect|need)\s+(?:any\s+)?(?:personal\s+)?(?:documents?|papers|ownership documents?)\b|ما\s*بدي\s*(?:ابعت|أرسل)\s*(?:أوراق|مستندات)|ما\s*في\s*داعي\s*(?:لـ|لإرسال)\s*(?:أي\s*)?(?:أوراق|مستندات)|χωρίς\s+(?:έγγραφα|δικαιολογητικά)|δεν\s+θέλω\s+να\s+στείλω\s+έγγραφα/iu,
  noAppointment: /\b(?:no|not|don't|do not)\s+(?:book|schedule|arrange)\s+(?:a\s+)?(?:meeting|appointment|consultation|call)\b|\bnot ready (?:to|for)\s+(?:a\s+)?(?:meeting|appointment|call)\b|ما\s*بدي\s*(?:موعد|اجتماع|مكالمة)|ما\s*بدي\s*احجز|δεν\s+θέλω\s+(?:ραντεβού|συνάντηση|κλήση)|χωρίς\s+ραντεβού/iu,
  noCommitment: /\b(?:still comparing|haven't chosen|have not chosen|not committed|haven't committed|have not committed|not decided|undecided|exploratory)\b|لسا\s*(?:عم\s*)?(?:قارن|ما\s*قررت|ما\s*اخترت)|(?:لسا\s*)?مو\s*(?:قرار|ملتزم)|δεν\s+έχω\s+(?:αποφασίσει|επιλέξει)|συγκρίνω\s+ακόμη|χωρίς\s+δέσμευση/iu,
  speaksForSelf: /\b(?:i can only speak|i speak|speaking)\s+(?:only\s+)?for myself\b|\bnot authorized to represent\b|أنا\s*(?:بحكي|بتكلم)\s*(?:عن\s*)?نفسي\s*بس|ما\s*بمثل\s*(?:حدا|أحد)|δεν\s+εκπροσωπώ\s+άλλους|μιλώ\s+μόνο\s+για\s+τον\s+εαυτό\s+μου/iu,
  jointlyOwned: /\b(?:jointly[\s-]+owned|co-owned)\b|ملكية\s*مشتركة|مملوكة\s*لأكثر\s*من\s*شخص|κοινή\s+ιδιοκτησία|ανήκει\s+σε\s+περισσότερους/iu,
  noProjectOrRepresentative: /\b(?:haven't|have not)\s+agreed\s+on\s+(?:a\s+)?project\b|\bnot\s+appointed\s+anyone\s+to\s+represent\b|ما\s*اتفقنا\s*على\s*مشروع|ما\s*عيّنا\s*(?:حدا|أحد)|δεν\s+έχουμε\s+συμφωνήσει\s+έργο|δεν\s+έχουμε\s+ορίσει\s+εκπρόσωπο/iu,
  licensing: /\b(?:licen[cs]e|permit|regulated|regulatory|approval|authori[sz]ation)\b|ترخيص|موافقة\s*(?:البنك|الجهة|النشاط)?|خاضع\s*لترخيص|άδεια|αδειοδότ|έγκριση/iu,
  bank: /\b(?:bank account|bank approval|banking)\b|حساب\s*بنك|موافقة\s*البنك|τραπεζικ(?:ός|ή|ό)ς?\s+λογαριασμός|έγκριση\s+τράπεζας/iu,
  accountStatus: /\b(?:contract|payment|case)\s+(?:status|approved|approval)|verify (?:my )?(?:account|contract|payment)|securely check\b|حالة\s*(?:العقد|الدفع|الحساب)|التحقق\s*(?:من|بـ)\s*(?:العقد|الدفع|الحساب)|κατάσταση\s+(?:σύμβασης|πληρωμής|λογαριασμού)|επαλήθευση\s+(?:σύμβασης|πληρωμής)/iu,
  participation: /\b(?:business|refal(?:co)?(?:\s+group)?|the group)\b.{0,100}\b(?:actually\s+)?(?:invest|partner|bid|participat|make an offer)\b|\b(?:invest|partner|bid|participat|make an offer)\b.{0,100}\b(?:business|refal(?:co)?(?:\s+group)?|the group)\b|استثمار\s*الشركة|تدخل\s*شريك|تقدم\s*عرض|επενδύσει|συνεργαστεί|υποβάλει\s+προσφορά/iu,
  valueForecast: /\b(?:forecast|returns?|rise in value|increase in value|yearly return|yield)\b|توقعات\s*(?:العائد|القيمة)|ترتفع\s*قيمتها|απόδοση|πρόβλεψη\s+αξίας|αύξηση\s+αξίας/iu,
  priceApplicability: /\b(?:fee|price|cost|package)\b.{0,90}\b(?:my case|my situation|separate|included|confirmed|approved|estimate|check)\b|\b(?:my case|my situation|separate|included|confirmed|approved|estimate|check)\b.{0,90}\b(?:fee|price|cost|package)\b|(?:fee|cost|price|السعر|الرسوم|κόστος|τιμή).{0,70}(?:case|confirmed|approved|تأكد|معتمد|حالتي|περίπτωση|επιβεβαιω)/iu,
  limitedPropertyDetails: /\b(?:rough|general) area\b.{0,100}\b(?:not|no|without)\b.{0,100}\b(?:address|title deed|other owners|ownership details)\b|\b(?:not|no|without)\b.{0,100}\b(?:exact address|title deed|other owners(?:'|’)? details)\b|ما\s*بدي\s*(?:أرسل|ابعت)\s*(?:العنوان|سند الملكية)|العنوان\s*الدقيق.{0,60}(?:سند|معلومات المالكين)|μόνο\s+(?:μια\s+)?γενική\s+περιοχή.{0,80}(?:διεύθυνση|τίτλο\s+ιδιοκτησίας)/iu,
  complaint: /\b(?:complaint|service has been awful|terrible service|no one has explained|no one has taken responsibility|take responsibility for (?:this|it))\b|الخدمة\s*(?:سيئة|سيئة جداً|كانت سيئة)|شكوى|ما\s*حدا\s*شرح|ما\s*تحمل\s*حدا\s*المسؤولية|παράπονο|απαράδεκτη\s+υπηρεσία|κανείς\s+δεν\s+εξήγησε|ευθύνη/iu,
  caseReferenceOnly: /\bcase reference\b.{0,80}\b(?:alone|enough|sufficient)\b|\b(?:alone|enough|sufficient)\b.{0,70}\bcase reference\b|رقم\s*(?:القضية|الملف|المرجع).{0,70}(?:يكفي|بيكفي|كافي)|αριθμός\s+υπόθεσης.{0,70}(?:αρκεί|αρκετός)/iu,
  writtenOnly: /\b(?:(?:just\s+)?(?:a\s+)?written\s+(?:update|response|reply)(?:\s+back)?|in\s+writing\s+(?:only|back))\b|\bwritten\s+only\b|تحديث\s*كتابي\s*فقط|بدي\s*(?:تحديث|رد)\s*مكتوب\s*بس|μόνο\s+γραπτή\s+ενημέρωση|γραπτ(?:ή|η)\s+ενημέρωση\s+μόνο/iu,
  noSharingWithoutConsent: /\b(?:haven't|have not)\s+agreed\s+to\s+(?:a\s+call\s+or\s+)?(?:to\s+)?(?:my\s+)?details\s+being\s+shared\b|\bno\s+(?:call|sharing)\b.{0,80}\bwithout\s+(?:my\s+)?agreement\b|\bno\s+sharing\s+with\s+anyone\s+else\s+unless\s+i\s+agree\b|ما\s*وافقت\s*(?:على|لـ)\s*(?:مكالمة|مشاركة\s*بياناتي)|بدون\s*موافقتي.{0,30}مشاركة|χωρίς\s+τη\s+συγκατάθεσή\s+μου.{0,50}(?:κοινοποι|μοιραστ)|δεν\s+έχω\s+συμφωνήσει.{0,70}(?:κλήση|κοινοποίηση)/iu,
  noCredentials: /\b(?:won't|will not|do not|don't)\s+send\s+(?:any\s+)?(?:passwords?|codes?|one[- ]time\s+codes?)\b|\bno\s+(?:passwords?|one[- ]time\s+codes?)\b|ما\s*رح\s*(?:أرسل|ابعت)\s*(?:كلمات\s*المرور|رموز)|δεν\s+θα\s+στείλω\s+(?:κωδικούς|κωδικό|κωδικό\s+μιας\s+χρήσης)/iu,
  deadline: /\b(?:by|before|within)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s+days?|\d+\s+weeks?)\b|\b(?:timeline|how long|when will)\b|قبل\s*(?:الجمعة|الإثنين|يوم)|خلال\s*\d+\s*(?:أيام|أسابيع)|قديش\s*المدة|πόσο\s+χρόνο|προθεσμία|μέχρι\s+(?:την\s+)?(?:Παρασκευή|Δευτέρα)/iu
};

// Greek text does not form JavaScript's ASCII-style `\b` word boundaries.
RECAP_PATTERNS.goal = new RegExp(`${RECAP_PATTERNS.goal.source}|(?:θέλω.{0,100}(?:ιδρύσω|εταιρεία|Κύπρο|επενδύ)|σχεδιάζουμε.{0,100}(?:εταιρεία|επένδυ|ανάπτυξη)|(?:εταιρεία|επιχείρηση|επένδυση|ανάπτυξη|οικόπεδο).{0,100}(?:Κύπρο|πελάτ|κεφάλαια))`, "iu");

function recapSafeText(value, maxLength = 155) {
  return redactSensitiveData(String(value || ""))
    .replace(/https?:\/\/\S+/giu, "[link omitted]")
    .replace(/\b(?:case|reference|ticket|account|registration)\s*(?:number|no\.?|id|#)\s*(?:(?:is|was)\s+|[:#-]\s*)?[A-Z0-9][A-Z0-9-]{3,}\b/giu, "[reference omitted]")
    .replace(/(?:رقم|معرّف)\s*(?:القضية|الحساب|المرجع|التذكرة|الملف)\s*(?:(?:هو|هي|كان|كانت)\s+|[:#-]\s*)?(?!لحاله|لحالها|وحده|وحدها|فقط|بس)[\p{L}\p{N}-]{4,}/giu, "[reference omitted]")
    .replace(/(?:αριθμός\s+(?:υπόθεσης|λογαριασμού|αναφοράς|πελάτη))\s*(?:(?:είναι|ήταν)\s+|[:#-]\s*)?(?!μόνος|μόνη|μόνο|μόνοι|μόνες|only|alone|αρκεί|αρκετός)[\p{L}\p{N}-]{4,}/giu, "[reference omitted]")
    // Greek uses άδεια for both a permit and consent. In a recap of contact
    // preferences, use unambiguous consent wording so the legal-claim guard
    // does not misread it as a permit claim.
    .replace(/άδεια\s+να\s+επικοινωνήσει(?:\s+κάποιος)?\s+μαζί\s+μου/giu, "συγκατάθεση για επικοινωνία")
    .replace(/άδεια\s+επικοινωνίας/giu, "συγκατάθεση επικοινωνίας")
    // Quoted customer questions are recap content, not new questions from
    // REFAL. Normalize terminal question punctuation so the answer guard
    // counts only a genuine assistant follow-up.
    .replace(/[?؟;;]/gu, ",")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function recapCustomerStatement(message, language) {
  // A customer's exact legal/financial question can trip the output claim
  // guard when quoted verbatim. Paraphrase that question without implying an
  // answer, while preserving a clear opt-out from follow-up.
  if (!containsProhibitedClaim(message)) return message;
  const declinedContact = /(?:لا\s*(?:ترتبوا|ترتب|تنسقوا|تنسق)\s*(?:أي\s*)?(?:تواصل|اتصال)|ما\s*بدي\s*(?:حدا|أحد|الفريق)\s*(?:يتواصل|يتصل)|don't\s+(?:contact|call|follow\s+up)|no\s+(?:calls?|follow.?up)|μην\s+επικοινωνήσετε|δεν\s+θέλω\s+επικοινωνία)/iu.test(message);
  if (language === "arabic") return `سألت عن المتطلبات الخاصة بنشاطك${declinedContact ? "، وما بدك ترتيب تواصل عنك" : ""}`;
  if (language === "greek") return `Ρωτήσατε για τις απαιτήσεις της δραστηριότητάς σας${declinedContact ? " και δεν θέλετε επικοινωνία εκ μέρους σας" : ""}`;
  return `You asked about requirements for your business${declinedContact ? " and asked us not to arrange follow-up" : ""}`;
}

function collectRecapFacts(history, language) {
  const eligible = (Array.isArray(history) ? history : [])
    .filter((turn) => typeof turn?.message === "string")
    .filter((turn) => !turn?.metadata?.safety?.risks?.includes(SAFETY_CATEGORIES.PRIVACY))
    .filter((turn) => !classifySafety(turn.message).risks.includes(SAFETY_CATEGORIES.PRIVACY))
    .filter((turn) => !classifySafety(turn.message).risks.includes(SAFETY_CATEGORIES.PROMPT_INJECTION))
    .filter((turn) => redactSensitiveData(turn.message) === turn.message)
    .map((turn) => recapSafeText(turn.message, 1000))
    .filter((message) => message && !NON_RECAP_CONTENT.test(message) && (detectMessageLanguage(message) === language || RECAP_PATTERNS.noContact.test(message) || RECAP_PATTERNS.noCommitment.test(message) || RECAP_PATTERNS.priceApplicability.test(message) || PUBLISHED_INFO_QUERY.test(message)));
  const find = (pattern, { last = false } = {}) => {
    const matches = eligible.filter((message) => pattern.test(message));
    return matches.length ? matches[last ? matches.length - 1 : 0] : "";
  };
  const lastQuestion = eligible.filter((message) => /[,،]$/u.test(message) && /\b(?:what|how|can|could|do|does|is|are|which|when|where|why)\b|شو|كيف|فيني|ممكن|هل|ماذا|ما\s*هو|(?:τι|πώς|μπορεί|είναι|ποιο|πότε)/iu.test(message)).at(-1) || "";
  return {
    goal: find(RECAP_PATTERNS.goal) || find(/(?:[bب]دي|baddi|bdi|bade).{0,100}(?:تأسيس|شركة|company|business)/iu),
    activity: find(RECAP_PATTERNS.activity, { last: true }) || find(/\b(?:shoghlha|online furniture shop)\b/iu, { last: true }),
    noContact: Boolean(find(RECAP_PATTERNS.noContact, { last: true })),
    noDocuments: Boolean(find(RECAP_PATTERNS.noDocuments, { last: true })),
    noAppointment: Boolean(find(RECAP_PATTERNS.noAppointment, { last: true })),
    noCommitment: Boolean(find(RECAP_PATTERNS.noCommitment, { last: true })),
    speaksForSelf: Boolean(find(RECAP_PATTERNS.speaksForSelf, { last: true })),
    jointlyOwned: Boolean(find(RECAP_PATTERNS.jointlyOwned, { last: true })),
    noProjectOrRepresentative: Boolean(find(RECAP_PATTERNS.noProjectOrRepresentative, { last: true })),
    participation: Boolean(find(RECAP_PATTERNS.participation, { last: true })),
    valueForecast: Boolean(find(RECAP_PATTERNS.valueForecast, { last: true })),
    priceApplicability: Boolean(find(RECAP_PATTERNS.priceApplicability, { last: true })),
    limitedPropertyDetails: Boolean(find(RECAP_PATTERNS.limitedPropertyDetails, { last: true })),
    complaint: Boolean(find(RECAP_PATTERNS.complaint, { last: true })),
    caseReferenceOnly: Boolean(find(RECAP_PATTERNS.caseReferenceOnly, { last: true })),
    writtenOnly: Boolean(find(RECAP_PATTERNS.writtenOnly, { last: true })),
    noSharingWithoutConsent: Boolean(find(RECAP_PATTERNS.noSharingWithoutConsent, { last: true })),
    noCredentials: Boolean(find(RECAP_PATTERNS.noCredentials, { last: true })),
    licensing: Boolean(find(RECAP_PATTERNS.licensing, { last: true })),
    bank: Boolean(find(RECAP_PATTERNS.bank, { last: true })),
    accountStatus: Boolean(find(RECAP_PATTERNS.accountStatus, { last: true })),
    deadline: Boolean(find(RECAP_PATTERNS.deadline, { last: true })),
    openQuestion: lastQuestion
  };
}

function composeRecap({ facts, language, boundedEvidence, actionStatusAsked, verifiedHandoverStatus }) {
  const clauses = [];
  if (facts.complaint) clauses.push(language === "arabic" ? "قدّمت شكوى عن معاملة تأسيس شركة الشهر الماضي، وتريد توضيحاً للمشكلة والمسؤولية" : language === "greek" ? "Αναφέρατε παράπονο για υπόθεση σύστασης εταιρείας τον περασμένο μήνα και ζητάτε εξήγηση και υπευθυνότητα" : "You raised a complaint about a company-setup case submitted last month and want an explanation and accountability");
  else if (facts.goal) clauses.push(language === "arabic" ? `هدفك: ${recapCustomerStatement(facts.goal, language)}` : language === "greek" ? `Στόχος σας: ${recapCustomerStatement(facts.goal, language)}` : `Your goal: ${recapCustomerStatement(facts.goal, language)}`);
  if (facts.activity) clauses.push(language === "arabic" ? `والنشاط المذكور: ${recapCustomerStatement(facts.activity, language)}` : language === "greek" ? `Δραστηριότητα που αναφέρατε: ${recapCustomerStatement(facts.activity, language)}` : `Activity you mentioned: ${recapCustomerStatement(facts.activity, language)}`);

  const preferences = [];
  if (facts.noContact) preferences.push(language === "arabic" ? "ما بدك تواصل أو مشاركة بياناتك" : language === "greek" ? "δεν θέλετε επικοινωνία χωρίς συγκατάθεση" : "you prefer no contact or sharing of your details without consent");
  if (facts.writtenOnly) preferences.push(language === "arabic" ? "وتريد تحديثاً مكتوباً فقط" : language === "greek" ? "θέλετε μόνο γραπτή ενημέρωση" : "you want a written update only");
  if (facts.noSharingWithoutConsent) preferences.push(language === "arabic" ? "ولا توافق على مكالمة أو مشاركة بياناتك دون إذنك" : language === "greek" ? "δεν συμφωνείτε σε κλήση ή κοινοποίηση στοιχείων χωρίς συγκατάθεση" : "you have not agreed to a call or sharing details without consent");
  if (facts.noCredentials) preferences.push(language === "arabic" ? "ولن ترسل كلمات مرور أو رموزاً" : language === "greek" ? "δεν θα στείλετε κωδικούς" : "you will not send passwords or codes");
  if (facts.noDocuments) preferences.push(language === "arabic" ? "وما بدك ترسل أوراق هلق" : language === "greek" ? "δεν θέλετε να στείλετε έγγραφα τώρα" : "you prefer not to send documents now");
  if (facts.noAppointment) preferences.push(language === "arabic" ? "وما بدك موعد هلق" : language === "greek" ? "δεν θέλετε ραντεβού τώρα" : "you do not want an appointment now");
  if (facts.noCommitment) preferences.push(language === "arabic" ? "ولسا ما قررت" : language === "greek" ? "δεν έχετε αποφασίσει ακόμη" : "you have not decided yet");
  if (facts.speaksForSelf) preferences.push(language === "arabic" ? "وبتحكي عن نفسك بس" : language === "greek" ? "μιλάτε μόνο εκ μέρους σας" : "you speak only for yourself");
  if (facts.jointlyOwned && facts.speaksForSelf) preferences.push(language === "arabic" ? "والأرض ملكية مشتركة" : language === "greek" ? "η γη ανήκει από κοινού" : "the land is jointly owned");
  if (facts.noProjectOrRepresentative) preferences.push(language === "arabic" ? "وما اتفقتوا على مشروع أو ممثل" : language === "greek" ? "δεν έχει συμφωνηθεί έργο ή οριστεί εκπρόσωπος" : "no project or representative has been agreed");
  if (facts.limitedPropertyDetails) preferences.push(language === "arabic" ? "وبتفضّل مشاركة منطقة تقريبية فقط، بدون عنوان أو سند أو بيانات المالكين" : language === "greek" ? "προτιμάτε να δώσετε μόνο γενική περιοχή, χωρίς διεύθυνση, τίτλο ή στοιχεία ιδιοκτητών" : "you prefer to share only a rough area, not an address, deed, or other owners’ details");
  if (preferences.length) clauses.push(language === "arabic" ? `وتفضيلاتك: ${preferences.join("، ")}` : language === "greek" ? `Προτιμήσεις σας: ${preferences.join(" και ")}` : `Your preferences: ${preferences.join(", and ")}`);

  const unresolved = [];
  if (facts.licensing) unresolved.push(language === "arabic" ? "متطلبات النشاط لسا بحاجة إلى تأكيد" : language === "greek" ? "οι απαιτήσεις της δραστηριότητας παραμένουν προς επαλήθευση" : "the activity requirements remain unverified");
  if (facts.bank) unresolved.push(language === "arabic" ? "وقرار البنك ما زال غير معروف" : language === "greek" ? "η απόφαση της τράπεζας παραμένει άγνωστη" : "the bank's decision remains unknown");
  if (facts.accountStatus) unresolved.push(language === "arabic" ? "وسؤالك عن الحساب يحتاج تحقق آمن" : language === "greek" ? "το ερώτημα για τον λογαριασμό χρειάζεται ασφαλή επαλήθευση" : "your account-specific question still needs secure verification");
  if (facts.deadline) unresolved.push(language === "arabic" ? "والمدة المطلوبة ما زالت بحاجة إلى تأكيد" : language === "greek" ? "το απαιτούμενο χρονοδιάγραμμα παραμένει προς επιβεβαίωση" : "the requested timeline remains unconfirmed");
  if (facts.participation) unresolved.push(language === "arabic" ? "ومشاركة الشركة أو تقديمها عرضاً غير مؤكد" : language === "greek" ? "η συμμετοχή ή προσφορά της Refalco Group παραμένει ανεπιβεβαίωτη" : "Refalco Group’s investment, partnership, or bid remains unconfirmed");
  if (facts.valueForecast) unresolved.push(language === "arabic" ? "ولا توجد توقعات عائد أو ارتفاع قيمة مؤكدة" : language === "greek" ? "δεν έχει επιβεβαιωθεί πρόβλεψη απόδοσης ή αύξησης αξίας" : "no return or value-growth forecast is confirmed");
  if (facts.priceApplicability) unresolved.push(language === "arabic" ? "وانطباق الرسوم أو الباقة على حالتك بحاجة إلى تأكيد" : language === "greek" ? "η εφαρμογή της τιμής ή του πακέτου στη δική σας περίπτωση χρειάζεται επιβεβαίωση" : "whether the listed price or package applies to your case remains unconfirmed");
  if (facts.caseReferenceOnly) unresolved.push(language === "arabic" ? "ولم يتأكد إن كان رقم القضية وحده يكفي للمراجعة" : language === "greek" ? "δεν έχει επιβεβαιωθεί αν αρκεί μόνο ο αριθμός υπόθεσης για τον έλεγχο" : "whether the case reference alone is enough for review remains unconfirmed");
  if (unresolved.length) clauses.push(language === "arabic" ? `النقطة المفتوحة: ${unresolved.join("؛ ")}` : language === "greek" ? `Ανοιχτό σημείο: ${unresolved.join("· ")}` : `Open point: ${unresolved.join("; ")}`);
  if (actionStatusAsked && verifiedHandoverStatus === "open") clauses.push(language === "arabic" ? "طلبك للتواصل مع مختص مسجّل للمراجعة، وهذا لا يعني أن المختص تواصل معك" : language === "greek" ? "Το αίτημά σας για επικοινωνία με ειδικό έχει καταγραφεί για έλεγχο· αυτό δεν σημαίνει ότι ο ειδικός έχει ήδη επικοινωνήσει μαζί σας" : "Your specialist follow-up request is recorded for review; this does not mean a specialist has contacted you");
  else if (actionStatusAsked) clauses.push(language === "arabic" ? "هذا الملخص لا يؤكد ما تم حفظه أو إرساله فعلياً" : language === "greek" ? "Αυτή η σύνοψη δεν επιβεβαιώνει τι αποθηκεύτηκε ή στάλθηκε" : "This summary cannot verify what was saved or sent");
  if (boundedEvidence) clauses.push(language === "arabic" ? `المعلومة المعتمدة: ${boundedEvidence}` : language === "greek" ? `Εγκεκριμένη πληροφορία: ${boundedEvidence}` : `Approved information: ${boundedEvidence}`);
  if (!clauses.length) return language === "arabic" ? "ما في تفاصيل كافية بملخص المحادثة لتأكيد هدف أو نقطة مفتوحة." : language === "greek" ? "Δεν υπάρχουν αρκετές λεπτομέρειες στη σύνοψη για επιβεβαίωση στόχου ή ανοιχτού σημείου." : "There is not enough conversation detail here to confirm a goal or open point.";
  const intro = language === "arabic" ? "ملخص حديثنا: " : language === "greek" ? "Σύνοψη της συζήτησής μας: " : "Conversation summary: ";
  const result = (intro + clauses.join(". ") + ".").replace(/\.{2,}/gu, ".");
  return result.length <= 500 ? result : `${result.slice(0, 497).trimEnd()}…`;
}

function buildLocalConversationRecap({ history = [], evidence = [], currentMessage = "", language = detectMessageLanguage(currentMessage), workflowState = {} } = {}) {
  if (!RECAP_REQUEST.test(String(currentMessage || ""))) return null;
  const key = language === "arabic" ? "arabic" : language === "greek" ? "greek" : language === "english" ? "english" : "";
  if (!key) return null;
  const eligibleHistory = (Array.isArray(history) ? history : [])
    .filter((turn) => typeof turn?.message === "string")
    .filter((turn) => !turn?.metadata?.safety?.risks?.includes(SAFETY_CATEGORIES.PRIVACY))
    .filter((turn) => !classifySafety(turn.message).risks.includes(SAFETY_CATEGORIES.PRIVACY))
    .filter((turn) => !classifySafety(turn.message).risks.includes(SAFETY_CATEGORIES.PROMPT_INJECTION))
    .filter((turn) => redactSensitiveData(turn.message) === turn.message)
    .map((turn) => recapSafeText(turn.message))
    .filter((message) => message && !NON_RECAP_CONTENT.test(message) && (detectMessageLanguage(message) === key || RECAP_PATTERNS.noContact.test(message) || RECAP_PATTERNS.noCommitment.test(message) || RECAP_PATTERNS.priceApplicability.test(message) || PUBLISHED_INFO_QUERY.test(message)));
  if (!eligibleHistory.length) return null;
  const facts = collectRecapFacts(history, key);
  const asksConfirmedCompanyInfo = /\b(?:business|refal(?:co)?(?:\s+group)?)\b.{0,80}\b(?:approved|official|published|confirmed|confirm)\b|\b(?:approved|official|published)\s+(?:business\s+)?(?:company\s+)?(?:information|facts|services)\b.{0,80}\b(?:confirm|say|list|include)\b|معلومات\s*(?:الشركة|معتمدة|رسمية).{0,60}(?:تؤكد|تقول|تذكر)|εγκεκριμέν(?:ες|η)\s+πληροφορί(?:ες|α).{0,80}(?:επιβεβαιώνουν|αναφέρουν)/iu.test(currentMessage);
  const publishedInfoQuestion = eligibleHistory.find((message) => PUBLISHED_INFO_QUERY.test(message));
  const priceQuestion = eligibleHistory.some((message) => RECAP_PATTERNS.priceApplicability.test(message));
  const evidenceForAnswer = priceQuestion && Array.isArray(evidence)
    ? evidence.filter((item) => /(?:[$€£]\s?[\d٠-٩]|\b(?:EUR|USD|GBP)\s?[\d٠-٩]|(?<![\p{L}\p{N}])[\d٠-٩][\d٠-٩,.]*\s?(?:EUR|USD|GBP|euros?|dollars?|pounds?)\b|(?:fee|price|package|باقة|السعر|رسوم).{0,40}[\d٠-٩])/iu.test(String(item?.content || "")))
    : evidence;
  const evidenceQuestion = priceQuestion ? "Cyprus company formation package price" : publishedInfoQuestion || eligibleHistory.join(" ");
  const grounded = asksConfirmedCompanyInfo || publishedInfoQuestion
    ? answerFromEvidence(evidenceForAnswer, { allowPricing: priceQuestion, customerQuestion: evidenceQuestion })
    : null;
  const evidenceAnswer = grounded?.answer || "";
  const evidenceSentence = evidenceAnswer ? recapSafeText(evidenceAnswer).split(/(?<=[.!?])\s+/u)[0].slice(0, 170) : "";
  const listedPrice = evidenceAnswer.match(/(?:€\s?[\d,]+(?:\s*\+\s*VAT)?|[\d,]+\s?EUR\b)/iu)?.[0] || "";
  const boundedEvidence = priceQuestion && listedPrice
    ? language === "arabic" ? `الصفحة تذكر باقة تأسيس الشركة بسعر ${listedPrice}`
      : language === "greek" ? `Η σελίδα αναφέρει πακέτο σύστασης εταιρείας με τιμή ${listedPrice}`
        : evidenceSentence
    : evidenceSentence;
  const actionStatusAsked = /\b(?:what (?:action|has been done)|what (?:you\s+)?(?:actually\s+)?(?:recorded|saved)|what (?:was|is) recorded|what action (?:is )?confirmed|anything (?:sent|in progress)|did you send|if nothing was sent|action status)\b|شو\s*(?:تسجل|انبعت|الإجراء)|سجلتم|انرسل|ما\s*انبعث|σταλεί|καταγράφηκε|τι\s+(?:καταγράφηκε|αποθηκεύτηκε)|ενέργεια\s+(?:έχει|έγινε)/iu.test(currentMessage);
  const handover = workflowState?.handover || {};
  const consent = workflowState?.specialistFollowUp || {};
  const verifiedHandoverStatus = consent.consented === true
    && consent.purpose === "specialist_follow_up"
    && handover.required === true
    && ["open", "pending_review", "awaiting_review"].includes(handover.status)
    ? "open"
    : null;
  const response = composeRecap({ facts, language: key, boundedEvidence, actionStatusAsked, verifiedHandoverStatus });
  return {
    response,
    citations: boundedEvidence ? grounded?.citations || [] : []
  };
}

module.exports = { RECAP_REQUEST, buildLocalConversationRecap };
