"use strict";

const CREDENTIAL_ASSIGNMENT = /\b(password|passcode|pin|token|api[\s_-]*key|access[\s_-]*token|secret|bank(?:ing)?[\s_-]*(?:login|credentials?))\b\s*(?:is|:|=)\s*["']?([^\s,;.!?؟]{3,})/giu;
const CREDENTIAL_ASSIGNMENT_UNICODE = /(كلمة\s*(?:المرور|السر)|رمز\s*(?:الدخول|التعريف)?|بيانات\s*(?:الدخول|البنك)|κωδικός(?:\s+πρόσβασης)?|κωδικό|τραπεζικά\s+στοιχεία)\s*(?:هو|هي|είναι|:|=)\s*["']?([\p{L}\p{N}._@#$%^&*-]{4,})/giu;
const FINANCIAL_VALUE_LABEL = /\b(iban|account(?:\s+number)?|bank\s+account|otp|one[- ]time\s+(?:password|code)|verification\s+code|cvv|cvc|security\s+code|passport(?:\s+(?:number|no\.?))?|national\s+id(?:\s+(?:number|no\.?))?|identity\s+card(?:\s+(?:number|no\.?))?)\b\s*(?:(?:is|:|#|=)\s*)?([\p{L}\p{N}][\p{L}\p{N} -]{2,30})/giu;
const FINANCIAL_VALUE_LABEL_UNICODE = /(رقم\s*(?:الحساب|الآيبان|الايبان|الجواز|الهوية)|(?:رمز|كود)\s*(?:التحقق|التأكيد|لمرة\s*واحدة)|رمز\s*الأمان|رقم\s*البطاقة|αριθμ\p{L}*\s*(?:λογαριασμ\p{L}*|διαβατηρ\p{L}*|ταυτότητ\p{L}*)|κωδικός\s*επιβεβαίωσης|κωδικός\s*μιας\s*χρήσης)\s*(?:(?:هو|είναι|:|#|=)\s*)?([\p{L}\p{N}][\p{L}\p{N} -]{2,30})/giu;
const STRUCTURAL_SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/gu;
const STRUCTURAL_IBAN = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/giu;
const STRUCTURAL_CARD = /(?<![\p{L}\p{N}])(?:[0-9٠-٩۰-۹][ -]?){13,19}(?![\p{L}\p{N}])/gu;

function passesLuhn(value) {
  const digits = String(value || "").replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0)).replace(/\D/gu, "");
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

function containsSensitiveOutputValue(text) {
  const value = String(text || "");
  if (value.match(STRUCTURAL_SECRET) || value.match(STRUCTURAL_IBAN)) return true;
  if ((value.match(STRUCTURAL_CARD) || []).some(passesLuhn)) return true;
  const isPlaceholder = (candidate) => /^(?:\[?(?:redacted|hidden|omitted|unknown|none)\]?)$/iu.test(String(candidate || "").trim());
  if ([...value.matchAll(CREDENTIAL_ASSIGNMENT), ...value.matchAll(CREDENTIAL_ASSIGNMENT_UNICODE)].some((match) => !isPlaceholder(match[2]))) return true;
  for (const match of [...value.matchAll(FINANCIAL_VALUE_LABEL), ...value.matchAll(FINANCIAL_VALUE_LABEL_UNICODE)]) {
    const label = String(match[1] || "");
    const candidate = String(match[2] || "").trim().replace(/[ -]+$/u, "");
    if (isPlaceholder(candidate)) continue;
    const digits = candidate.replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0)).replace(/\D/gu, "");
    const hasMixedId = /\p{L}/u.test(candidate) && digits.length >= 3;
    const shortSecurityCode = /\b(?:otp|cvv|cvc|security\s+code|verification\s+code)\b/iu.test(label) && digits.length >= 3;
    if (digits.length >= 6 || hasMixedId || shortSecurityCode) return true;
  }
  return false;
}

const containsLabeledSensitiveValue = containsSensitiveOutputValue;
module.exports = { containsLabeledSensitiveValue, containsSensitiveOutputValue };
