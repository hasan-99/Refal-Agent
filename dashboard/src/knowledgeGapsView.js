// Pure view helpers for the Knowledge Gaps page (no React, unit-tested).

export const PAGE_SIZE = 20;

export const STATUS_TABS = Object.freeze([
  { id: "active", label: "Active" },
  { id: "done", label: "Resolved" },
  { id: "ignored", label: "Ignored" },
  { id: "all", label: "All" }
]);

export const PRIORITY_LABELS = Object.freeze({ critical: "Critical", high: "High", medium: "Medium", low: "Low" });
export const LANGUAGE_LABELS = Object.freeze({ en: "English", ar: "Arabic", el: "Greek", und: "Unknown" });
export const LANGUAGE_SHORT = Object.freeze({ en: "EN", ar: "AR", el: "EL", und: "?" });

// Filters hidden behind the "Filters" panel; search and status stay visible.
export const PANEL_FILTERS = Object.freeze(["priority", "reason", "language", "category"]);

export const EMPTY_FILTERS = Object.freeze({ q: "", status: "active", priority: "all", reason: "all", language: "all", category: "all" });

export function humanize(value) {
  return String(value || "general").replace(/_/gu, " ").replace(/^\w/u, (letter) => letter.toUpperCase());
}

export function activeFilterCount(filters = {}) {
  return PANEL_FILTERS.filter((key) => filters[key] && filters[key] !== "all").length;
}

export function buildListQuery(filters = {}, { offset = 0, limit = PAGE_SIZE } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const text = String(value ?? "").trim();
    if (text && text !== "all") params.set(key, text);
  }
  if (!params.has("status")) params.set("status", "all");
  params.set("limit", String(limit));
  params.set("offset", String(Math.max(0, offset)));
  return params.toString();
}

// Appends a page while dropping ids already shown (a gap can move between
// pages when it is updated during scrolling).
export function mergePage(current = [], incoming = []) {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => item?.id && !seen.has(item.id))];
}

const RELATIVE_STEPS = [
  { unit: "year", ms: 365 * 86400000 }, { unit: "month", ms: 30 * 86400000 }, { unit: "week", ms: 7 * 86400000 },
  { unit: "day", ms: 86400000 }, { unit: "hour", ms: 3600000 }, { unit: "minute", ms: 60000 }
];

export function relativeTime(value, now = Date.now()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "—";
  const diff = time - now;
  if (Math.abs(diff) < 60000) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const step = RELATIVE_STEPS.find((item) => Math.abs(diff) >= item.ms) || RELATIVE_STEPS.at(-1);
  return format.format(Math.round(diff / step.ms), step.unit);
}

export function initials(value) {
  const text = String(value || "").split("@")[0].replace(/[._-]+/gu, " ").trim();
  if (!text) return "?";
  const parts = text.split(/\s+/u);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : text.slice(0, 2)).toUpperCase();
}

export function percent(share) {
  const value = Number(share);
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

// SVG path for the 14-day sparkline (area under the line), in a 100x32 box.
export function sparklinePath(points = []) {
  if (!points.length) return { line: "", area: "" };
  const max = Math.max(1, ...points.map((point) => Number(point.count) || 0));
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const coords = points.map((point, index) => [Number((index * step).toFixed(2)), Number((30 - ((Number(point.count) || 0) / max) * 26).toFixed(2))]);
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join(" ");
  return { line, area: `${line} L100 32 L0 32 Z` };
}
