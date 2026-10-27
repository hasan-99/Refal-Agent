// GENERATED FILE — do not edit by hand.
// Source: src/privacyHardRule.js
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.

import { detectMessageLanguage, foldArabicLetters, foldRulePatterns } from "./language.mjs";
import { FALLBACKS } from "./safetyPolicy.mjs";

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

const EN_REQUEST = "(?:send|sending|share|sharing|provide|providing|give|giving|type|typing|enter|entering|paste|reply with|confirm|forward|upload|attach|email|tell me|tell us|(?:could|can|would) you tell (?:me|us)|i need|we need|please supply|supply|what is|what's|what’s|may i have|can you give)";
const AR_REQUEST = "(?:أرسل|ارسل|أرسلي|ابعت|ابعتلي|بعتلي|شاركني|أعطني|اعطني|أعطيني|اعطيني|زودني|زوّدني|اكتب|اكتبلي|احكيلي|قلي|ما هي|ما هو|شو هي|شو هو|شو|رجاء|رجاءً|من فضلك|بحاجة|نحتاج|لازم ترسل|ارفع|أرفق|ارفق)";
const EL_REQUEST = "(?:στείλτε|στείλε|στείλτε μου|μοιραστείτε|μοιράσου|δώστε|δώσε|πείτε(?:\\s+μου)?|πες(?:\\s+μου)?|γράψτε|γράψε|πληκτρολογήστε|επιβεβαιώστε|προωθήστε|ανεβάστε|επισυνάψτε|χρειάζομαι|χρειαζόμαστε|ποιος είναι|ποιο είναι|παρακαλώ στείλτε)";

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
    "(?:كلمة المرور|كلمة السر|كلمه مرورك|كلمه سرك|كلمات المرور|كلمات السر|الرمز السري|رمز الدخول السري)",
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
  ["code", /\b(?:otp|one[ -]?time (?:code|password|pin)|verification code|authentication code|sms code|security code|access code)\b|(?:رمز التحقق|رمز التفعيل|كود التحقق|رمز لمرة واحدة|الرمز اللي وصلك|الكود اللي وصلك)|(?:κωδικ\p{L}*|OTP)/iu],
  ["thirdParty", /\b(?:your bank|the bank|your provider|your (?:email|app|wallet|exchange)|another (?:company|service|provider|app)|third party|you received|received from|sent to you by|they sent you|the bank sent)\b|(?:البنك|بنكك|مزود الخدمة|وصلك من|أرسله لك البنك|تطبيق تاني|جهة تانية)|(?:η τράπεζα|την τράπεζα|ο πάροχος|λάβατε από|σας έστειλε η τράπεζα|άλλη εταιρεία|τρίτο μέρος)/iu]
];

const OTP_PAIRED_SENSITIVE_TARGET = /\b(?:passport|national id|identity card|account number|bank account|card details?)\b|(?:رقم\s*(?:الجواز|الهوية|الحساب)|رقم\s*البطاقة|بيانات\s*البطاقة)|(?:διαβατηρ\p{L}*|ταυτότητ\p{L}*|λογαριασμ\p{L}*|κάρτ\p{L}*)/iu;

const otpParts = Object.fromEntries(foldRulePatterns(rawOtp));

function normalizeOutboundText(text) {
  return foldArabicLetters(
    String(text || "").normalize("NFKC").replace(/[ً-ٰٟـ]/gu, "").replace(/\s+/gu, " ").trim()
  );
}

function isNegatedRequestAt(text, index) {
  const prefix = text.slice(Math.max(0, index - 48), index).split(/[.!?؟;؛,،]/u).at(-1) || "";
  return /\b(?:do not|don't|never|should not|shouldn't|must not|mustn't|cannot|can't)\s*$/iu.test(prefix)
    || /(?:لا|ما\s*بدي|ممنوع|μην|μη|ποτέ\s+μην)\s*$/iu.test(prefix);
}

function isInformationalCredentialQuestion(text, match) {
  // Scope every carve-out to this specific request-pattern match. A definition
  // elsewhere in the same sentence must never excuse another request match.
  const matchedText = match[0].trim();
  const followingText = text.slice(match.index + match[0].length, match.index + match[0].length + 60).split(/[.!?؟;؛]/u)[0];
  const context = `${matchedText}${followingText}`;
  return /^what\s+(?:is|are)\s+(?:(?:the\s+)?(?:definition|meaning)\s+of\s+(?:a|an|the)\s+)?(?:(?:a|an)\s+)?(?:password|passcode|pin|bank statement|account statement|card details?|credentials?)\s*$/iu.test(matchedText)
    || /^what\s+(?:does|do)\s+(?:a|an|the)?\s*(?:password|passcode|pin|bank statement|account statement|card details?|credentials?)\s+mean\s*$/iu.test(matchedText)
    || /^tell me what\s+(?:a|an|the)\s+(?:password|passcode|pin|bank statement|account statement|card detail|credential)s?\s+(?:is|are|means?|includes?|contains?|shows?|used)\s*$/iu.test(context)
    || /^(?:could|can)\s+you\s+tell\s+(?:me|us)\s+what\s+(?:a|an|the)\s+(?:password|passcode|pin|bank statement|account statement|card detail|credential)s?\s+(?:is|are|means?|includes?|contains?|shows?|used)\s*$/iu.test(context)
    || /^share\s+what\s+(?:a|an|the)\s+(?:password|passcode|pin|bank statement|account statement|card detail|credential)s?\s+(?:is|are|means?|includes?|contains?|shows?|used)\s*$/iu.test(context)
    || /^(?:شو\s+هي|ما\s+هي|ما\s+هو)\s+(?:كلمه المرور|كلمه السر|كشف الحساب|بيان الحساب)\s*$/u.test(matchedText)
    || /^شو\s+يعني[^.!?؟;؛,،]{0,32}(?:كلمه المرور|كلمه السر|كشف الحساب|بيان الحساب)\s*$/u.test(matchedText)
    || /^(?:ما\s*(?:هي|هو)|شو\s*(?:هي|هو)|كيف)\s*[^.!?؟;؛,،]{0,48}(?:كلمة المرور|كلمة السر|رقم التعريف الشخصي|كشف الحساب|بيانات البطاقة)[^.!?؟;؛,،]{0,24}(?:يعني|يتضمن|يشمل|يحتوي)\s*$/iu.test(matchedText)
    || /^(?:ποιο\s+είναι|τι\s+είναι)\s+(?:το\s+)?(?:τραπεζικό\s+αντίγραφο|αντίγραφο\s+κίνησης)\s*$/iu.test(matchedText)
    || /^(?:τι|ποιο|πώς)\s*[^.!?;؛,،]{0,48}(?:κωδικ\p{L}*\s+πρόσβασ\p{L}*|τραπεζικ\p{L}*\s+αντίγραφ\p{L}*|στοιχεί\p{L}*\s+κάρτ\p{L}*)[^.!?;؛,،]{0,24}(?:είναι|περιλαμβάνει|περιέχει|σημαίνει)\s*$/iu.test(matchedText)
    || /^share\s+what\s+(?:a|an|the)\s+(?:password|passcode|pin|bank statement|account statement|card detail|credential)s?\s+(?:is|are|means?|includes?|contains?|shows?|used)\b/iu.test(context);
}

function hasUnnegatedRequest(pattern, text) {
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/g/gu, "")}g`);
  let match;
  while ((match = matcher.exec(text)) !== null) {
    if (!isNegatedRequestAt(text, match.index) && !isInformationalCredentialQuestion(text, match)) return true;
    // Deliberately scan overlapping matches too: an initial negated warning
    // can match across punctuation and consume a later affirmative request.
    matcher.lastIndex = match.index + 1;
  }
  return false;
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

  const kinds = rules.filter(([, pattern]) => hasUnnegatedRequest(pattern, value)).map(([kind]) => kind);

  if (hasUnnegatedRequest(otpParts.verb, value) && otpParts.code.test(value)
      && (otpParts.thirdParty.test(value) || OTP_PAIRED_SENSITIVE_TARGET.test(value))) {
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

export { CREDENTIAL_KINDS, requestsForbiddenCredential, safePrivacyRedirect };
