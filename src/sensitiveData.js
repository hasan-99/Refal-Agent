const REDACTED = "[redacted]";

const LABELED_SECRET = /\b(password|passcode|pin|token|api[\s_-]*key|access[\s_-]*token|secret|bank(?:ing)?[\s_-]*(?:login|credentials?))\b[^.!?\n]{0,180}/giu;
const LABELED_SECRET_UNICODE = /(كلمة\s*(?:المرور|السر)|رمز\s*(?:الدخول|التعريف)?|بيانات\s*(?:الدخول|البنك)|κωδικός|κωδικό|κάρτα|τραπεζικά\s+στοιχεία)[^.!؟?\n]{0,180}/giu;
const FINANCIAL_ID_LABEL = /\b(iban|account(?:\s+number)?|bank\s+account|otp|one[- ]time\s+(?:password|code)|verification\s+code|cvv|cvc|security\s+code|passport(?:\s+(?:number|no\.?))?|national\s+id(?:\s+(?:number|no\.?))?|identity\s+card(?:\s+(?:number|no\.?))?)\b\s*(?:is|:|#|=)?\s*[^.!?;\n]{1,40}/giu;
const FINANCIAL_ID_LABEL_UNICODE = /(رقم\s*(?:الحساب|الآيبان|الايبان|الجواز|الهوية)|(?:رمز|كود)\s*(?:التحقق|التأكيد|لمرة\s*واحدة)|رمز\s*الأمان|رقم\s*البطاقة|αριθμός\s*(?:λογαριασμού|διαβατηρίου|ταυτότητας)|κωδικός\s*επιβεβαίωσης|κωδικός\s*μιας\s*χρήσης)[^.!؟?;\n]{0,80}/giu;
const IBAN_LIKE = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/giu;
const TOKEN_SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/gu;
const CARD_LIKE = /(?<![\p{L}\p{N}])(?:[0-9٠-٩۰-۹][ -]?){13,19}(?![\p{L}\p{N}])/gu;

const NON_DISCLOSURE = /(?:\b(?:(?:i|we|you)\s+)?(?:please\s+)?(?:will not|won't|do not|don't|cannot|can't|never)\s+(?:send|share|give|provide|disclose)\s+(?:a|an|any|my|the)?\s*|(?:ما\s*رح|لن|لا\s+أريد|ما\s+بدي|مو\s+رح|مش\s+رح)\s*(?:أرسل|ارسل|أشارك|شارك|أعطي|اعطي|أبعث|ابعث)\s*(?:أي|رمز|بيانات)?\s*|(?:δεν\s+θα|δεν\s+θέλω\s+να|μην)\s*(?:στείλω|μοιραστώ|δώσω|κοινοποιήσω)\s*(?:κανένα|στοιχεία)?\s*)$/iu;

function isNonDisclosureMention(text, matchIndex, labelEnd) {
  const prefix = String(text || "").slice(Math.max(0, matchIndex - 90), matchIndex);
  if (!NON_DISCLOSURE.test(prefix)) return false;
  const afterLabel = String(text || "").slice(labelEnd, labelEnd + 60);
  // Still redact an explicitly labeled value even when the surrounding
  // sentence says it should not be shared.
  return !/^\s*(?:is|:|=|هو|هي|είναι)\s*[\p{L}\p{N}][\p{L}\p{N}._!@#$%^&*-]{2,}/iu.test(afterLabel);
}

function passesLuhn(value) {
  const digits = String(value || "").replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0)).replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// Output-side check (REFAL-AGENT-011): unlike redactSensitiveData (tuned for
// INPUT, where over-redacting a mere mention is the safe failure mode), a
// customer-facing response must not be rejected just for naming a credential
// type ("please don't send your password here" must stay allowed). This only
// tests the three structurally-unambiguous VALUE patterns already defined
// above — a real IBAN shape, a real provider-token prefix, or a digit string
// that actually passes Luhn — never the label-proximity patterns, which are
// the part of redactSensitiveData that conflates "mentions a type" with
// "contains a value". Reuses the same regexes, no duplicated detection logic.
// Uses String.prototype.match (not .test) because these regexes carry the
// `g` flag: a global regex's .test() mutates lastIndex across calls and
// silently alternates true/false on repeated calls with the same input.
function containsRawSecretValue(text) {
  const value = String(text || "");
  if (value.match(TOKEN_SECRET)) return true;
  if (value.match(IBAN_LIKE)) return true;
  const cardCandidates = value.match(CARD_LIKE) || [];
  return cardCandidates.some((candidate) => passesLuhn(candidate));
}

function redactSensitiveData(value) {
  let text = String(value || "");
  text = text.replace(FINANCIAL_ID_LABEL, (match, label, offset, input) => isNonDisclosureMention(input, offset, offset + label.length) ? match : `${label}: ${REDACTED}`);
  text = text.replace(FINANCIAL_ID_LABEL_UNICODE, (match, label, offset, input) => isNonDisclosureMention(input, offset, offset + label.length) ? match : `${label}: ${REDACTED}`);
  text = text.replace(IBAN_LIKE, REDACTED);
  text = text.replace(LABELED_SECRET, (match, label, offset, input) => isNonDisclosureMention(input, offset, offset + label.length) ? match : `${label} ${REDACTED}`);
  text = text.replace(LABELED_SECRET_UNICODE, (match, label, offset, input) => isNonDisclosureMention(input, offset, offset + label.length) ? match : `${label} ${REDACTED}`);
  text = text.replace(TOKEN_SECRET, REDACTED);
  text = text.replace(CARD_LIKE, (match) => passesLuhn(match) ? REDACTED : match);
  return text;
}

module.exports = { REDACTED, redactSensitiveData, passesLuhn, containsRawSecretValue };
