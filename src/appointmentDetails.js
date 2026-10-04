const { isPlausibleCustomerName } = require("./messageRouter.js");

const SUPPORTED_FORMATS = Object.freeze(["whatsapp", "phone", "video", "office"]);
function normalizeAppointmentDetails({ user = {}, purpose = "", timezone = "", language = "english", format = "whatsapp" } = {}) {
  const profile = user.profile || {};
  const selected = String(format || "whatsapp").toLowerCase().trim();
  const configured = String(process.env.APPOINTMENT_FORMATS || SUPPORTED_FORMATS.join(",")).split(",").map((item) => item.trim().toLowerCase()).filter((item) => SUPPORTED_FORMATS.includes(item));
  const allowed = configured.length ? configured : ["whatsapp"];
  const meetingFormat = allowed.includes(selected) ? selected : allowed[0];
  const details = {
    name: isPlausibleCustomerName(profile.name) ? profile.name : null,
    phone: user.phone || String(user.id || "").replace(/@.+$/, "") || null,
    email: profile.email || null,
    company: profile.company || null,
    topic: String(purpose || "").trim().slice(0, 1000) || null,
    language: String(language || profile.language || "english").slice(0, 30),
    timezone: String(timezone || process.env.BOOKING_TIMEZONE || "Europe/Nicosia").slice(0, 80),
    format: meetingFormat,
    supportedFormats: allowed
  };
  const configuredRequired = String(process.env.APPOINTMENT_REQUIRED_FIELDS || "name,phone,topic,language,timezone,format").split(",").map((item) => item.trim()).filter(Boolean);
  const supportedRequired = new Set(["name", "phone", "email", "company", "topic", "language", "timezone", "format"]);
  details.required = configuredRequired.filter((field) => supportedRequired.has(field));
  details.missing = ["name", "phone", "email", "company", "topic", "language", "timezone", "format"].filter((field) => !details[field]);
  details.missingRequired = details.required.filter((field) => details.missing.includes(field));
  details.ready = details.missingRequired.length === 0;
  return details;
}
module.exports = { SUPPORTED_FORMATS, normalizeAppointmentDetails };
