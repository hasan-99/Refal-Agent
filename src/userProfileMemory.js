"use strict";

// Controlled durable per-contact profile (RAFA_USER_PROFILE_MEMORY).
//
// Stored inside the existing rafa_contacts.profile jsonb under
// `memoryProfile`, so no schema change is needed and the existing
// conversation reset (refal_reset_conversation_context) already removes it:
// that RPC rebuilds profile from a short allowlist that does not include it.
//
// Only these fields, each with status/source/timestamps:
//   name                 confirmed, customer-stated (never a WhatsApp label)
//   preferredLanguage    only when the customer explicitly asked for a language
//   customerType         only when the customer explicitly said it
//   longTermPreferences  explicit contact-channel preferences (max 3)
//   serviceInterest      earlier service interest, marked inferred (max 4)
// Never stored: messages, requirements, tentative ideas, open questions,
// countries, budgets, contact details, identifiers or anything sensitive.
// Verified identifiers are deliberately not stored (the existing-client
// verification flow owns them).
//
// Every read and write is fail-safe: a missing store method, a malformed
// value or a failed write leaves the turn unchanged.

const PROFILE_VERSION = 1;
const MAX_PROFILE_BYTES = 2048;
const FIELD_NAMES = Object.freeze(["name", "preferredLanguage", "customerType", "longTermPreferences", "serviceInterest"]);
const LANGUAGES = new Set(["arabic", "english", "greek"]);
const STATUSES = new Set(["confirmed", "inferred", "corrected"]);
const SOURCES = new Set(["user", "system"]);

function safeEntry(entry, { allowStatuses = STATUSES, maxChars = 80 } = {}) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.value !== "string" || !entry.value.trim()) return null;
  if (!allowStatuses.has(entry.status) || !SOURCES.has(entry.source)) return null;
  const updatedAt = Date.parse(entry.updatedAt || "");
  if (!Number.isFinite(updatedAt)) return null;
  return { value: entry.value.trim().slice(0, maxChars), status: entry.status, source: entry.source,
    firstSeenAt: typeof entry.firstSeenAt === "string" ? entry.firstSeenAt.slice(0, 40) : entry.updatedAt, updatedAt: new Date(updatedAt).toISOString() };
}

function fresh(entry, cutoff) {
  return entry && Date.parse(entry.updatedAt) >= cutoff ? entry : null;
}

/** Reads and sanitizes profile.memoryProfile, dropping entries past retention. Never throws. */
function readProfileMemory(user, { now = Date.now(), retentionDays = 180 } = {}) {
  try {
    const raw = user?.profile?.memoryProfile;
    if (!raw || typeof raw !== "object" || raw.version !== PROFILE_VERSION || !raw.fields || typeof raw.fields !== "object") return null;
    const cutoff = now - retentionDays * 86_400_000;
    const fields = {};
    const name = fresh(safeEntry(raw.fields.name, { allowStatuses: new Set(["confirmed"]), maxChars: 60 }), cutoff);
    if (name && name.source === "user") fields.name = name;
    const language = fresh(safeEntry(raw.fields.preferredLanguage, { allowStatuses: new Set(["confirmed"]) }), cutoff);
    if (language && LANGUAGES.has(language.value)) fields.preferredLanguage = language;
    const type = fresh(safeEntry(raw.fields.customerType, { allowStatuses: new Set(["confirmed"]) }), cutoff);
    if (type && ["business", "individual"].includes(type.value)) fields.customerType = type;
    const prefs = (Array.isArray(raw.fields.longTermPreferences) ? raw.fields.longTermPreferences : [])
      .map((entry) => fresh(safeEntry(entry, { allowStatuses: new Set(["confirmed"]), maxChars: 60 }), cutoff)).filter(Boolean).slice(-3);
    if (prefs.length) fields.longTermPreferences = prefs;
    const interests = (Array.isArray(raw.fields.serviceInterest) ? raw.fields.serviceInterest : [])
      .map((entry) => fresh(safeEntry(entry, { allowStatuses: new Set(["inferred"]), maxChars: 40 }), cutoff)).filter(Boolean).slice(-4);
    if (interests.length) fields.serviceInterest = interests;
    return Object.keys(fields).length ? { version: PROFILE_VERSION, fields } : null;
  } catch {
    return null;
  }
}

function pick(entry, fallbackStatus) {
  return entry ? { value: entry.value, status: fallbackStatus || entry.status, source: entry.source, firstSeenAt: entry.firstSeenAt || entry.updatedAt, updatedAt: entry.updatedAt } : null;
}

/**
 * Derives the next durable profile from the session state. Returns
 *   { action: "none" } | { action: "write", profile } | { action: "delete" }
 * Only confirmed, customer-stated values are promoted; tentative items and
 * agent inferences never are (service interest is kept, labelled inferred).
 */
function deriveProfileUpdate(sessionState, existing = null, { now = Date.now() } = {}) {
  if (!sessionState) return { action: "none" };
  if (sessionState.conversation?.forgetRequested || sessionState.user?.forgotten) return existing ? { action: "delete" } : { action: "none" };
  const nowIso = new Date(now).toISOString();
  const fields = { ...(existing?.fields || {}) };
  const user = sessionState.user || {};
  const rejected = (user.nameCorrections || []).map((entry) => String(entry.value || "").toLocaleLowerCase());
  if (fields.name && rejected.includes(fields.name.value.toLocaleLowerCase())) delete fields.name;
  if (user.name?.status === "confirmed" && user.name.source === "user" && user.name.origin !== "profile") fields.name = pick(user.name);
  if (user.language?.preferred?.status === "confirmed" && LANGUAGES.has(user.language.preferred.value) && user.language.preferred.origin !== "profile") fields.preferredLanguage = pick(user.language.preferred);
  if (user.customerType?.status === "confirmed" && user.customerType.origin !== "profile") fields.customerType = pick(user.customerType);
  if (user.channelPreference?.status === "confirmed" && user.channelPreference.origin !== "profile") {
    const prefs = (fields.longTermPreferences || []).filter((entry) => entry.value !== user.channelPreference.value);
    fields.longTermPreferences = [...prefs, pick(user.channelPreference)].slice(-3);
  }
  const interests = (sessionState.conversation?.interests || []).filter((entry) => entry.origin !== "profile").map((entry) => pick(entry, "inferred"));
  if (interests.length) {
    const merged = [...(fields.serviceInterest || []).filter((entry) => !interests.some((next) => next.value === entry.value)), ...interests];
    fields.serviceInterest = merged.slice(-4).map((entry) => ({ ...entry, status: "inferred", source: "system" }));
  }
  for (const key of Object.keys(fields)) if (!FIELD_NAMES.includes(key)) delete fields[key];
  const next = { version: PROFILE_VERSION, updatedAt: nowIso, fields };
  const comparable = (profile) => JSON.stringify(Object.fromEntries(Object.entries(profile?.fields || {}).map(([key, value]) =>
    [key, Array.isArray(value) ? value.map((entry) => [entry.value, entry.status]) : [value.value, value.status]])));
  if (!Object.keys(fields).length) return existing ? { action: "delete" } : { action: "none" };
  if (existing && comparable(existing) === comparable(next)) return { action: "none" };
  while (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_PROFILE_BYTES && next.fields.serviceInterest?.length) next.fields.serviceInterest.shift();
  return { action: "write", profile: next };
}

/** Applies the update through store.updateUser. Never throws; returns the outcome only. */
async function persistProfileMemory(store, userId, update) {
  if (!update || update.action === "none") return { status: "unchanged" };
  if (typeof store?.updateUser !== "function") return { status: "unsupported" };
  try {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}) };
      if (update.action === "delete") delete draft.profile.memoryProfile;
      else draft.profile.memoryProfile = update.profile;
    });
    return { status: update.action === "delete" ? "deleted" : "written" };
  } catch {
    return { status: "failed" };
  }
}

module.exports = { readProfileMemory, deriveProfileUpdate, persistProfileMemory, PROFILE_VERSION, FIELD_NAMES, MAX_PROFILE_BYTES };
