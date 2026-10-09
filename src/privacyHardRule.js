const { detectMessageLanguage, foldArabicLetters, foldRulePatterns } = require("./language");
const { FALLBACKS } = require("./safetyPolicy");

// P2.5 / W2.5.4 — the OUTBOUND privacy hard rule (MB-SEC4).
//
// Direction matters, and this is the half that did not exist. src/safetyPolicy.js
// has a PRIVACY category for INBOUND customer messages: it catches a customer
// pasting their own password or IBAN into the chat. That gate is untouched here.
//
// This module is the opposite direction: it asks whether a message REFAL is
// about to send REQUESTS a forbidden credential or document. MB-SEC4 makes that
// absolutely forbidden, and a model can produce it without any customer having
// typed anything sensitive, so the inbound classifier can never see it.
//
// The redirect wording is reused from safetyPolicy's FALLBACKS[...].privacy
// rather than re-authored, because it already says exactly the right thing in
// all three languages and a second copy would drift.
//
// Two carve-outs that are deliberate, not oversights:
//
//  - A verification code THIS system issued and sends to the contact already on
//    file is not a forbidden credential request; it is the W2.5.5 mechanism.
//    The otp kind therefore requires a THIRD PARTY source cue (your bank, your
//    provider, a code you received elsewhere). Asking a customer to forward a
//    code another institution sent them is the phishing pattern MB-SEC4 bans.
//  - A neutral explanation of what a bank statement is is not a request for one.
//    Every document pattern requires a request verb.
//
// REGEX WARNING: \b is ASCII-only in JavaScript even under /u. No Arabic or
// Greek alternative below is \b-wrapped. Latin terms are \b-anchored so they
// cannot match inside an ordinary word (BLK-15).

const CREDENTIAL_KINDS = Object.freeze({
  PASSWORD: "password",
  PIN: "pin",
  CARD_DATA: "card_data",
  OTP_OUT_OF_BAND: "otp_out_of_band",
  BANK_STATEMENT: "bank_statement",
  BANKING_CREDENTIALS: "banking_credentials"
});

const EN_REQUEST = "(?:send|sending|share|sharing|provide|providing|give|giving|type|typing|enter|entering|paste|reply with|confirm|forward|upload|attach|email|tell me|i need|we need|please supply|supply|what is|what's|what’s|may i have|can you give)";
const AR_REQUEST = "(?:أرسل|ارسل|أرسلي|ابعت|ابعتلي|بعتلي|شاركني|أعطني|اعطني|أعطيني|اعطيني|زودني|زوّدني|اكتب|اكتبلي|احكيلي|قلي|ما هي|ما هو|شو هي|شو هو|رجاء|رجاءً|من فضلك|بحاجة|نحتاج|لازم ترسل|ارفع|أرفق|ارفق)";
const EL_REQUEST = "(?:στείλτε|στείλε|στείλτε μου|μοιραστείτε|μοιράσου|δώστε|δώσε|γράψτε|γράψε|πληκτρολογήστε|επιβεβαιώστε|προωθήστε|ανεβάστε|επισυνάψτε|χρειάζομαι|χρειαζόμαστε|ποιος είναι|ποιο είναι|παρακαλώ στείλτε)";

function requestRule(id, en, ar, el) {
  const parts = [
    `\\b${EN_REQUEST}\\b[^.!?]{0,35}\\b(?:${en})\\b`,
    `${AR_REQUEST}[^.!?؟]{0,35}(?:${ar})`,
    `${EL_REQUEST}[^.!?;]{0,35}(?:${el})`
  ];
  return [id, new RegExp(parts.join("|"), "iu")];
}

const rawRules = [
  requestRule(
    CREDENTIAL_KINDS.PASSWORD,
    "(?:your |the |a |my )?(?:passwords?|passcodes?|login password|account password)",
    "(?:كلمة المرور|كلمة السر|كلمات المرور|كلمات السر|الرمز السري|رمز الدخول السري)",
    "(?:κωδικ[\\p{L}]*\\s+πρόσβασ[\\p{L}]*|μυστικ[\\p{L}]*\\s+κωδικ[\\p{L}]*|κωδικ[\\p{L}]*\\s+εισόδου)"
  ),
  requestRule(
    CREDENTIAL_KINDS.PIN,
    "(?:your |the |a |my )?(?:pin|pin code|pin number)",
    "(?:رقم التعريف الشخصي|الرقم السري للبطاقة|الرقم السري لبطاقتك|رمز البطاقة السري)",
    "(?:PIN|ΡΙΝ)"
  ),
  requestRule(
    CREDENTIAL_KINDS.CARD_DATA,
    "(?:card numbers?|card details|card data|credit card|debit card|cvv|cvc|card expiry|expiry date|security code on the (?:back|card)|three digits on the back)",
    "(?:رقم البطاقة|أرقام البطاقة|بيانات البطاقة|معلومات البطاقة|بطاقة الائتمان|بطاقة الخصم|تاريخ انتهاء البطاقة|الأرقام الثلاثة خلف البطاقة)",
    "(?:αριθμό κάρτας|αριθμός κάρτας|στοιχεία κάρτας|πιστωτικής κάρτας|χρεωστικής κάρτας|CVV|CVC|ημερομηνία λήξης της κάρτας)"
  ),
  requestRule(
    CREDENTIAL_KINDS.BANK_STATEMENT,
    "(?:bank statements?|account statements?|statement of account|bank records|transaction history)",
    "(?:كشف الحساب|كشف حساب|كشوفات الحساب|كشوف الحساب|بيان الحساب|حركة الحساب)",
    "(?:τραπεζικό αντίγραφο|τραπεζικά αντίγραφα|αντίγραφο κίνησης|κίνηση λογαριασμού|κινήσεις λογαριασμού|κατάσταση λογαριασμού)"
  ),
  requestRule(
    CREDENTIAL_KINDS.BANKING_CREDENTIALS,
    "(?:online banking (?:login|credentials|password|details)|banking credentials|bank login|internet banking details|e[- ]?banking (?:login|password|credentials))",
    "(?:بيانات الدخول للبنك|بيانات الدخول البنكية|معلومات الدخول البنكية|بيانات البنك|حساب البنك الإلكتروني)",
    "(?:τραπεζικά διαπιστευτήρια|κωδικούς e-banking|στοιχεία e-banking|κωδικό ηλεκτρονικής τραπεζικής)"
  )
];

const rules = foldRulePatterns(rawRules);

// The OTP kind is composed, not a single pattern, because all three conditions
// must hold: a request verb, a one time code term, and a THIRD PARTY source.
// Without the third condition this rule would fire on REFAL's own verification
// prompt, which is the approved mechanism rather than a violation.
const rawOtp = [
  ["verb", new RegExp(`\\b${EN_REQUEST}\\b|${AR_REQUEST}|${EL_REQUEST}`, "iu")],
  ["code", /\b(?:otp|one[ -]?time (?:code|password|pin)|verification code|authentication code|sms code|security code|access code)\b|(?:رمز التحقق|رمز التفعيل|كود التحقق|رمز لمرة واحدة|الرمز اللي وصلك|الكود اللي وصلك)|(?:κωδικό επαλήθευσης|κωδικό μίας χρήσης|OTP|κωδικό που λάβατε)/iu],
  ["thirdParty", /\b(?:your bank|the bank|your provider|your (?:email|app|wallet|exchange)|another (?:company|service|provider|app)|third party|you received|received from|sent to you by|they sent you|the bank sent)\b|(?:البنك|بنكك|مزود الخدمة|وصلك من|أرسله لك البنك|تطبيق تاني|جهة تانية)|(?:η τράπεζα|την τράπεζα|ο πάροχος|λάβατε από|σας έστειλε η τράπεζα|άλλη εταιρεία|τρίτο μέρος)/iu]
];

const otpParts = Object.fromEntries(foldRulePatterns(rawOtp));

function normalizeOutboundText(text) {
  return foldArabicLetters(
    String(text || "").normalize("NFKC").replace(/[ً-ٰٟـ]/gu, "").replace(/\s+/gu, " ").trim()
  );
}

/**
 * W2.5.4 — does an OUTBOUND REFAL message request a forbidden credential or a
 * sensitive financial document?
 *
 * Fail safe on empty input: nothing to send means nothing to violate.
 */
function requestsForbiddenCredential(text) {
  const value = normalizeOutboundText(text);
  const language = detectMessageLanguage(text);
  if (!value) return { violation: false, kinds: [], language };

  const kinds = rules.filter(([, pattern]) => pattern.test(value)).map(([kind]) => kind);

  if (otpParts.verb.test(value) && otpParts.code.test(value) && otpParts.thirdParty.test(value)) {
    kinds.push(CREDENTIAL_KINDS.OTP_OUT_OF_BAND);
  }

  const unique = [...new Set(kinds)];
  return { violation: unique.length > 0, kinds: unique, language };
}

/**
 * The approved replacement message. Reused verbatim from safetyPolicy's privacy
 * fallback so the two directions cannot drift apart in wording or in tone.
 */
function safePrivacyRedirect(language) {
  const block = FALLBACKS[language] || FALLBACKS.english;
  return block.privacy;
}

module.exports = { CREDENTIAL_KINDS, requestsForbiddenCredential, safePrivacyRedirect };
