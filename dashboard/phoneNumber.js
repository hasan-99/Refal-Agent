import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizeWhatsAppNumber(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 32 || !/^\+?[0-9 ()-]+$/.test(raw)) return "";
  const parsed = parsePhoneNumberFromString(raw);
  return parsed?.isValid() ? parsed.number : "";
}
