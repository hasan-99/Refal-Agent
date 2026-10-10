"use strict";

const { resolveConflict, SOURCE_LEVELS } = require("./policyPrecedence");

const MONEY = /(?:€|\$|£|\b(?:EUR|USD|GBP|CHF|AED)\b)\s*\d[\d,.]*|\d[\d,.]*\s*(?:€|\$|£|\b(?:EUR|USD|GBP|CHF|AED)\b)/iu;
const DYNAMIC_TERMS = /\b(?:price|prices|pricing|cost|fee|fees|renewal|renewals|property|properties|apartment|villa|deposit|reservation|government fee|registry fee|offer|package|formation package|company formation|incorporation)\b|السعر|أسعار|تكلفة|رسوم|عربون|باقة|عرض|عقار|شقة|فيلا|تأسيس شركة|σύσταση εταιρείας|τιμή|κόστος|τέλος|προκαταβολή|πακέτο|προσφορά|ακίνητ|διαμέρισμα|βίλα/iu;

function requestDynamicKinds(text) {
  const value = String(text || "");
  if (!DYNAMIC_TERMS.test(value)) return [];
  const kinds = [];
  if (/(?:formation|incorporation|company setup|company formation|تأسيس شركة|σύσταση εταιρείας|ίδρυση εταιρείας)/iu.test(value)) kinds.push({ kind: "offers", args: { code: "formation-package" }, subject: "formation-package" });
  if (/(?:renewal|secretary|registered address|accounting|audit fee|tax fee|تجديد|سكرتير|عنوان مسجل|λογιστ|ετήσι|γραμματειακ)/iu.test(value)) {
    const item = /secretary|سكرتير|γραμματειακ/iu.test(value) ? "secretary"
      : /address|عنوان مسجل/iu.test(value) ? "address"
        : /accounting|λογιστ/iu.test(value) ? "accounting"
          : /audit/iu.test(value) ? "audit" : /tax/iu.test(value) ? "tax" : null;
    if (item) kinds.push({ kind: "renewals", args: { item }, subject: item });
  }
  if (/(?:property|properties|apartment|villa|real estate|عقار|عقارات|شقة|فيلا|ακίνητ|διαμέρισμα|βίλα)/iu.test(value)) kinds.push({ kind: "properties", args: {}, subject: "property" });
  if (/(?:reservation|deposit|booking deposit|عربون|προκαταβολή)/iu.test(value)) {
    const identifier = value.match(/\b(?:project|property|unit)\s*(?:id|#|reference)?\s*[:#-]?\s*([a-z0-9-]{3,80})/iu)?.[1];
    if (identifier) kinds.push({ kind: "reservations", args: { projectOrPropertyId: identifier }, subject: identifier });
  }
  if (/(?:government fee|registry fee|land registry|application fee|رسوم حكومية|رسوم السجل|τέλος κτηματολογίου|κυβερνητικ.*τέλ)/iu.test(value)) {
    const feeType = /land registry|رسوم السجل|κτηματολογίου/iu.test(value) ? "land_registry"
      : /application|طلب|αίτηση/iu.test(value) ? "residency_application" : "company_registry";
    kinds.push({ kind: "governmentFees", args: { feeType }, subject: feeType });
  }
  return [...new Map(kinds.map((entry) => [`${entry.kind}:${entry.subject}`, entry])).values()];
}

function isDynamicQuestion(text) {
  DYNAMIC_TERMS.lastIndex = 0;
  return DYNAMIC_TERMS.test(String(text || ""));
}

function textValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return "";
}

function dynamicEvidence(kind, row) {
  if (!row || row.review_status !== "approved" || row.active !== true) return null;
  const validFrom = Date.parse(row.effective_from);
  const validUntil = Date.parse(row.valid_until);
  const verifiedAt = Date.parse(row.verified_at);
  const updatedAt = Date.parse(row.updated_at);
  const now = Date.now();
  if (![validFrom, validUntil, verifiedAt, updatedAt].every(Number.isFinite)
    || validFrom > now || validUntil <= now || verifiedAt > now || updatedAt > now) return null;
  if (kind === "properties" && row.available !== true) return null;
  const detail = Object.entries(row)
    .filter(([key, value]) => !["id", "review_status", "active", "verified_at", "updated_at", "source_note", "valid_from", "effective_from", "valid_until"].includes(key) && value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${["amount", "price", "deposit_amount"].includes(key) && row.currency ? `${row.currency} ${textValue(value)}` : textValue(value)}`)
    .filter((item) => !item.endsWith(": "));
  return {
    content: `Approved current ${kind} record. ${detail.join("; ")}`,
    source_name: `Current approved ${kind} data`,
    source_url: null,
    document_id: `dynamic:${kind}:${String(row.code || row.reference || row.item || row.fee_type || row.project_or_property_id || "current")}`,
    chunk_id: null,
    valid_until: row.valid_until,
    review_status: "approved",
    _dynamicKind: kind,
    _dynamicSubject: String(row.code || row.reference || row.item || row.fee_type || row.project_or_property_id || "").toLowerCase(),
    _effectiveDate: row.effective_from,
    _amount: Number.isFinite(row.amount) ? row.amount : Number.isFinite(row.price) ? row.price : Number.isFinite(row.deposit_amount) ? row.deposit_amount : null,
    _currency: row.currency || null
  };
}

function applyDynamicPrecedence(knowledge = [], live = [], requestedKinds = [], { failClosed = false } = {}) {
  const suppressed = new Set();
  const sourceKey = (chunk) => chunk?.chunk_id || chunk?.source_id || chunk?.document_id || chunk?.source_name || null;
  const decisions = [];
  for (const item of live) {
    if (item?._amount === null || !item?._dynamicSubject) continue;
    const subjectWords = item._dynamicSubject.split(/[-_ ]+/u).filter((part) => part.length > 2);
    for (const chunk of knowledge) {
      const content = String(chunk?.content || "");
      if (!MONEY.test(content)) continue;
      const subjectMatch = subjectWords.some((word) => content.toLocaleLowerCase().includes(word.toLocaleLowerCase()))
        || (item._dynamicKind === "offers" && /formation|incorporation|company setup|تأسيس الشركة|σύσταση εταιρείας/iu.test(content));
      if (!subjectMatch) continue;
      const staleAmount = new RegExp(`(?:€|\\bEUR\\b)\\s*${item._amount}(?![\\d,.])|${item._amount}\\s*(?:€|\\bEUR\\b)`, "iu").test(content) === false;
      if (!staleAmount) continue;
      const decision = resolveConflict([
        { level: SOURCE_LEVELS.LIVE_DATA, text: item.content, effectiveDate: item._effectiveDate },
        { level: SOURCE_LEVELS.APPROVED_KNOWLEDGE, text: content, effectiveDate: chunk.valid_until }
      ]);
      decisions.push(decision.label);
      const key = sourceKey(chunk);
      if (decision.winner?.level === SOURCE_LEVELS.LIVE_DATA && key) suppressed.add(key);
    }
  }
  // A dynamic fact query with no current row must never fall through to a
  // frozen commercial figure. Other approved service details can still answer.
  const unresolvedKind = failClosed || requestedKinds.some((kind) => !live.some((item) => item._dynamicKind === kind));
  const safeKnowledge = knowledge.filter((chunk) => !suppressed.has(sourceKey(chunk))
    && !(unresolvedKind && DYNAMIC_TERMS.test(String(chunk?.content || "")) && MONEY.test(String(chunk?.content || ""))));
  return { evidence: [...live, ...safeKnowledge], decisions };
}

async function collectDynamicFallback(store, text, { now = new Date() } = {}) {
  const requested = requestDynamicKinds(text);
  const live = [];
  const statuses = [];
  for (const request of requested) {
    try {
      const result = await store.lookupDynamicData(request.kind, request.args);
      if (result?.ok !== true || !["available", "found", "unavailable"].includes(result.status)) {
        statuses.push({ kind: request.kind, status: "error" });
        continue;
      }
      if (result.status === "unavailable") {
        statuses.push({ kind: request.kind, status: "unavailable" });
        continue;
      }
      const rows = Array.isArray(result?.data) ? result.data : [];
      const valid = rows.map((row) => dynamicEvidence(request.kind, row)).filter((row) => row && Date.parse(row.valid_until) > now.getTime());
      live.push(...valid.slice(0, 4));
      statuses.push({ kind: request.kind, status: valid.length ? "found" : "unavailable" });
    } catch {
      statuses.push({ kind: request.kind, status: "error" });
    }
  }
  return { requested, live, statuses };
}

module.exports = { requestDynamicKinds, isDynamicQuestion, dynamicEvidence, applyDynamicPrecedence, collectDynamicFallback };
