const LANGUAGE_ALIASES = Object.freeze({
  ar: "ar", arabic: "ar", العربية: "ar",
  en: "en", english: "en", inglés: "en",
  el: "el", greek: "el", ελληνικά: "el"
});

export function normalizeHandoverLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  return LANGUAGE_ALIASES[text] || "unknown";
}

export function filterHandovers(handovers = [], filters = {}) {
  const department = String(filters.department || "all").toLowerCase();
  const priority = String(filters.priority || "all").toLowerCase();
  const status = String(filters.status || "all").toLowerCase();
  const language = String(filters.language || "all").toLowerCase();
  const from = validDate(filters.from);
  const to = validDate(filters.to);

  const matches = (record) => {
    if (department !== "all" && String(record.department || "general").toLowerCase() !== department) return false;
    if (priority !== "all" && String(record.priority || "normal").toLowerCase() !== priority) return false;
    if (status !== "all" && String(record.status || "open").toLowerCase() !== status) return false;
    if (language !== "all" && normalizeHandoverLanguage(record.language) !== language) return false;
    const created = validDate(record.createdAt);
    if (from && (!created || created < from)) return false;
    if (to && (!created || created > to)) return false;
    return true;
  };

  // Contact rows represent several separate requests. Apply every active
  // constraint to the same constituent request; never combine a department
  // from one request with a language/date from another.
  return (Array.isArray(handovers) ? handovers : []).flatMap((item) => {
    const records = Array.isArray(item.records) && item.records.length ? item.records : [item];
    const matchedRecords = records.filter(matches);
    return matchedRecords.length ? [{ ...item, matchedRecords }] : [];
  });
}

function validDate(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : "";
}
