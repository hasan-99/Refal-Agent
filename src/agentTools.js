// Deterministic tool layer for the Agent orchestration loop (see agentLoop.js).
//
// The model may PROPOSE calling one of these tools with arguments; this file
// is the code that VALIDATES and EXECUTES. No tool here trusts a model-
// generated id blindly, writes outside an explicit allowlist, or bypasses an
// existing deterministic boundary (consent, privacy, knowledge approval).
// Tools wrap existing services (leadQualification, handover, supabaseStore)
// rather than reimplementing them.

const { createHash } = require("node:crypto");
const { detectMessageLanguage } = require("./language");
const { redactPersonalData } = require("./ai");

const { getConsentState } = require("./leadQualification");
const { createHandover } = require("./handover");
const { getConversationState } = require("./conversationState");
const { ok, fail } = require("./agentToolResult");
const { getBookingAvailability, requestBookingAction } = require("./agentBookingTools");
const { CRM_FIELDS, CUSTOMER_PROVENANCE, extractLiteralEvidence, extractLiteralSpan, isNegatedLiteralMention, isSelfIdentifiedName, isExplicitCorrectionMessage, normalizeForComparison, normalizeCrmCandidate } = require("./crmProfile");

const DYNAMIC_READS = Object.freeze({
  lookupActiveOffer: { kind: "offers", fields: ["code"] },
  lookupRenewalFees: { kind: "renewals", fields: ["item"] },
  searchPropertyInventory: { kind: "properties", fields: ["city", "type", "status", "bedrooms", "firstSale", "prEligible"] },
  lookupReservationRules: { kind: "reservations", fields: ["projectOrPropertyId"] },
  lookupGovernmentFees: { kind: "governmentFees", fields: ["feeType"] }
});

const ALLOWED_WRITE_CAPABILITIES = new Set([
  "upsertLead", "createHandover", "holdOrBookAppointment", "scheduleFollowUp", "recordComplianceEvent"
]);
const FOLLOW_UP_CONSENT_ACTIONS = new Set(["scheduleFollowUp"]);
const LEAD_FIELDS = new Set(["name", "nationality", "residence", "residenceCountry", "primaryGoal", "budget", "budgetAmount", "budgetCurrency"]);
const COMPLIANCE_TRIGGERS = new Set(["aml_concern", "sanctions_concern", "source_of_funds_unclear", "identity_mismatch", "high_risk_transaction"]);
const ACTION_FIELDS = Object.freeze({
  upsertLead: new Set(["fields"]),
  createHandover: new Set(["reason", "purpose", "department", "summary"]),
  holdOrBookAppointment: new Set(["start", "end", "purpose"]),
  scheduleFollowUp: new Set(["purpose", "dueAt"]),
  recordComplianceEvent: new Set(["trigger"])
});

const MAX_DYNAMIC_ROWS = 4;
const MAX_DYNAMIC_TEXT = 300;
const DYNAMIC_TOOL_TIMEOUT_MS = 12000;
const DYNAMIC_SYSTEM_FIELDS = new Set([
  "id", "code", "title_en", "title_ar", "title_el", "amount", "currency", "vat_note", "inclusions",
  "valid_from", "effective_from", "valid_until", "review_status", "active", "location", "eligibility",
  "updated_at", "verified_at", "item", "period", "notes_en", "notes_ar", "notes_el", "reference", "city",
  "type", "status", "price", "vat_rate_note", "bedrooms", "first_sale", "pr_eligible", "available",
  "developer", "delivery_date", "project_or_property_id", "deposit_amount", "deposit_percent", "refundable",
  "conditions_en", "conditions_ar", "conditions_el", "fee_type", "authority", "source_note"
]);

function trimString(value, max = MAX_DYNAMIC_TEXT) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function withTimeout(operation, timeoutMs = DYNAMIC_TOOL_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Tool request timed out.");
        error.code = "TOOL_TIMEOUT";
        reject(error);
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function timeoutFor(context) {
  const requested = Number(context?.toolTimeoutMs);
  return Number.isFinite(requested) && requested > 0 ? Math.min(requested, DYNAMIC_TOOL_TIMEOUT_MS) : DYNAMIC_TOOL_TIMEOUT_MS;
}

function allowedArgs(args, fields) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (Object.keys(args).some((key) => !fields.includes(key))) return null;
  return args;
}

function isFreshDynamicRow(row, now = new Date()) {
  if (!row || typeof row !== "object" || row.review_status !== "approved" || row.active !== true) return false;
  const effectiveFrom = Date.parse(row.effective_from);
  const validUntil = Date.parse(row.valid_until);
  const verifiedAt = Date.parse(row.verified_at);
  const updatedAt = Date.parse(row.updated_at);
  return Number.isFinite(effectiveFrom) && Number.isFinite(validUntil) && Number.isFinite(verifiedAt)
    && Number.isFinite(updatedAt) && effectiveFrom <= now.getTime() && now.getTime() < validUntil
    && verifiedAt <= now.getTime();
}

function isValidDynamicRow(kind, row) {
  if (!row || typeof row !== "object" || row.review_status !== "approved" || row.active !== true) return false;
  if (row.currency !== null && (typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency))) return false;
  if (row.eligibility !== null && (typeof row.eligibility !== "object" || Array.isArray(row.eligibility))) return false;
  if (kind === "offers") return typeof row.code === "string" && typeof row.amount === "number" && row.amount >= 0
    && Array.isArray(row.inclusions) && row.inclusions.every((item) => typeof item === "string");
  if (kind === "renewals") return ["secretary", "address", "accounting", "audit", "tax"].includes(row.item)
    && typeof row.amount === "number" && row.amount >= 0 && typeof row.period === "string";
  if (kind === "properties") return typeof row.reference === "string" && typeof row.price === "number" && row.price >= 0
    && typeof row.available === "boolean" && row.available === true
    && (row.pr_eligible === null || typeof row.pr_eligible === "boolean")
    && (row.first_sale === null || typeof row.first_sale === "boolean");
  if (kind === "reservations") return typeof row.project_or_property_id === "string"
    && ((typeof row.deposit_amount === "number" && row.deposit_amount >= 0 && row.deposit_percent == null)
      || (typeof row.deposit_percent === "number" && row.deposit_percent > 0 && row.deposit_percent <= 100 && row.deposit_amount == null))
    && (row.refundable === null || typeof row.refundable === "boolean");
  if (kind === "governmentFees") return typeof row.fee_type === "string" && typeof row.amount === "number" && row.amount >= 0
    && typeof row.authority === "string";
  return false;
}

function dynamicRecord(kind, row) {
  const eligibility = {};
  if (row.eligibility && typeof row.eligibility === "object" && !Array.isArray(row.eligibility)) {
    for (const [key, value] of Object.entries(row.eligibility).slice(0, 12)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
      if (typeof value === "string") eligibility[key] = value.slice(0, 120);
      else if (typeof value === "number" && Number.isFinite(value)) eligibility[key] = value;
      else if (typeof value === "boolean" || value === null) eligibility[key] = value;
    }
  }
  const shared = {
    kind,
    // `lookupDynamic()` has already required `row.active === true`; expose
    // that verified state so downstream policy consumers do not have to infer
    // it from omitted source columns.
    active: true,
    location: trimString(row.location, 40),
    currency: trimString(row.currency, 3),
    vatTreatment: trimString(row.vat_note || row.vat_rate_note),
    effectiveDate: trimString(row.effective_from, 40),
    lastUpdated: trimString(row.updated_at, 40),
    verifiedAt: trimString(row.verified_at, 40),
    validUntil: trimString(row.valid_until, 40),
    reviewStatus: "approved",
    provenance: "approved_live_edge_data",
    eligibility: Object.keys(eligibility).length ? eligibility : null,
    availability: typeof row.available === "boolean" ? row.available : null
  };
  const fields = {};
  for (const [key, value] of Object.entries(row)) {
    if (!DYNAMIC_SYSTEM_FIELDS.has(key) || ["id", "review_status", "active", "verified_at", "source_note"].includes(key)) continue;
    if (key === "inclusions" && Array.isArray(value)) fields.inclusions = value.filter((item) => typeof item === "string").slice(0, 20).map((item) => item.slice(0, MAX_DYNAMIC_TEXT));
    else if (typeof value === "string") fields[key] = value.slice(0, MAX_DYNAMIC_TEXT);
    else if (typeof value === "number" && Number.isFinite(value)) fields[key] = value;
    else if (typeof value === "boolean" || value === null) fields[key] = value;
  }
  return { ...shared, ...fields };
}

async function lookupDynamic(kind, args, { store, now = new Date(), toolTimeoutMs } = {}) {
  if (typeof store?.lookupDynamicData !== "function") return fail("error", "DYNAMIC_LOOKUP_UNAVAILABLE");
  try {
    const result = await withTimeout(store.lookupDynamicData(kind, args), timeoutFor({ toolTimeoutMs }));
    if (!result || typeof result !== "object" || result.ok !== true) {
      const status = result?.status === "unavailable" ? "unavailable" : "error";
      return fail(status, result?.reasonCode || (status === "unavailable" ? "DYNAMIC_DATA_UNAVAILABLE" : "DYNAMIC_LOOKUP_FAILED"), {
        userSafeSummary: status === "unavailable" ? "This information is not currently confirmed." : "I can't confirm this information right now.",
        modelObservation: { type: "dynamic_data", source: "trusted_edge_dynamic_read", kind, status, records: [] }
      });
    }
    const values = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    const current = values.filter((row) => isValidDynamicRow(kind, row) && isFreshDynamicRow(row, now));
    if (!current.length) return ok("unavailable", [], {
      userSafeSummary: "This information is not currently confirmed.",
      modelObservation: { type: "dynamic_data", source: "trusted_edge_dynamic_read", kind, status: "unavailable", records: [] }
    });
    const records = current.slice(0, MAX_DYNAMIC_ROWS).map((row) => dynamicRecord(kind, row));
    return ok("found", records, {
      userSafeSummary: `Current ${kind} information is available.`,
      modelObservation: { type: "dynamic_data", source: "trusted_edge_dynamic_read", kind, status: "found", records }
    });
  } catch (error) {
    const timedOut = error?.code === "TOOL_TIMEOUT";
    return fail(timedOut ? "timeout" : "error", timedOut ? "DYNAMIC_LOOKUP_TIMEOUT" : "DYNAMIC_LOOKUP_FAILED", {
      userSafeSummary: "I can't confirm this information right now.",
      modelObservation: { type: "dynamic_data", source: "trusted_edge_dynamic_read", kind, status: timedOut ? "unavailable" : "error", records: [] }
    });
  }
}

function validateDynamicReadArgs(name, args) {
  const contract = DYNAMIC_READS[name];
  const clean = allowedArgs(args, contract.fields);
  if (!clean) return null;
  if (contract.kind === "offers" && Object.keys(clean).length === 0) return {};
  if (contract.kind === "properties") {
    const normalized = {};
    for (const [key, value] of Object.entries(clean)) {
      if (key === "bedrooms") {
        if (!Number.isInteger(value) || value < 0 || value > 100) return null;
        normalized[key] = value;
      } else if (["firstSale", "prEligible"].includes(key)) {
        if (typeof value !== "boolean") return null;
        normalized[key] = value;
      } else {
        const text = trimString(value, 80);
        if (!text) return null;
        normalized[key] = text;
      }
    }
    return Object.keys(normalized).length ? normalized : null;
  }
  const key = contract.fields[0];
  const value = trimString(clean[key], 100);
  return value ? { [key]: value } : null;
}

function trustedCapabilities(context) {
  return new Set(Array.isArray(context?.allowedCapabilities) ? context.allowedCapabilities : []);
}

function safeActionArgs(name, args) {
  const fields = ACTION_FIELDS[name];
  const clean = allowedArgs(args, [...fields]);
  if (!clean) return null;
  if (name === "upsertLead") {
    if (!clean.fields || typeof clean.fields !== "object" || Array.isArray(clean.fields)) return null;
    const values = {};
    let budgetAmount;
    let budgetCurrency;
    for (const [key, value] of Object.entries(clean.fields)) {
      if (!LEAD_FIELDS.has(key)) return null;
      if (typeof value === "string") {
        const text = trimString(value, key === "name" ? 120 : 240);
        if (!text) return null;
        if (key === "budget") {
          const match = text.match(/^(?:([A-Z]{3})\s*)?(\d[\d,]*(?:\.\d{1,2})?)(?:\s*([A-Z]{3}))?$/);
          if (!match || Boolean(match[1]) === Boolean(match[3])) return null;
          budgetCurrency = match[1] || match[3];
          budgetAmount = Number(match[2].replace(/,/g, ""));
          if (!Number.isFinite(budgetAmount) || budgetAmount < 0) return null;
        } else if (key === "budgetCurrency") {
          if (!/^[A-Z]{3}$/.test(text)) return null;
          budgetCurrency = text;
        } else values[key === "residence" ? "residenceCountry" : key] = text;
      } else if (typeof value === "number" && Number.isFinite(value) && key === "budgetAmount" && value >= 0) budgetAmount = value;
      else return null;
    }
    if ((budgetAmount === undefined) !== (budgetCurrency === undefined)) return null;
    if (budgetAmount !== undefined) {
      values.budgetAmount = budgetAmount;
      values.budgetCurrency = budgetCurrency;
    }
    return Object.keys(values).length ? { profile: values } : null;
  }
  const result = {};
  for (const [key, value] of Object.entries(clean)) {
    if (["reason", "purpose", "department", "summary", "trigger"].includes(key)) {
      const text = trimString(value, key === "summary" ? 1200 : 240);
      if (!text) return null;
      result[key] = text;
    } else if (key === "dueAt") {
      const date = Date.parse(value);
      if (typeof value !== "string" || !Number.isFinite(date) || date < Date.now() + 60000 || date > Date.now() + 30 * 86400000) return null;
      result.dueAt = new Date(date).toISOString();
    } else if (["start", "end"].includes(key)) {
      const date = Date.parse(value);
      if (typeof value !== "string" || !Number.isFinite(date)) return null;
      result[key] = new Date(date).toISOString();
    }
  }
  if (name === "holdOrBookAppointment" && (!result.start || !result.end || !result.purpose)) return null;
  if (name === "scheduleFollowUp" && (result.purpose !== "specialist_follow_up" || !result.dueAt)) return null;
  if (name === "createHandover" && !result.reason && !result.purpose) return null;
  if (name === "recordComplianceEvent" && (!COMPLIANCE_TRIGGERS.has(result.trigger))) return null;
  return result;
}

async function performDynamicAction(name, args, context = {}) {
  if (!ALLOWED_WRITE_CAPABILITIES.has(name)) return fail("not_authorized", "ACTION_NOT_ALLOWED");
  if (!trustedCapabilities(context).has(name)) return fail("not_authorized", "CAPABILITY_REQUIRED");
  if (FOLLOW_UP_CONSENT_ACTIONS.has(name) && context.consentState !== "granted") return fail("not_authorized", "CONSENT_REQUIRED");
  if (!isPlainString(context.userId)) return fail("invalid_input", "TRUSTED_CONTACT_REQUIRED");
  if (name === "holdOrBookAppointment" && !isPlainString(context.inboundMessageId)) return fail("invalid_input", "INBOUND_MESSAGE_ID_REQUIRED");
  if (name !== "holdOrBookAppointment" && !isPlainString(context.sourceTurnId)) return fail("invalid_input", "PERSISTED_SOURCE_TURN_REQUIRED");
  const safeArgs = safeActionArgs(name, args);
  if (!safeArgs) return fail("invalid_input", "INVALID_ACTION_ARGUMENTS");
  if (name === "holdOrBookAppointment") {
    // The existing booking state machine owns slot freshness, idempotency,
    // calendar confirmation, and the distinction between pending review and
    // a real booking. The trusted capability is issued only after the caller
    // has verified the customer's explicit booking request/confirmation.
    const booking = await requestBookingAction(safeArgs, {
      ...context,
      inboundMessageId: context.inboundMessageId
    });
    if (!booking.ok) return fail(booking.status, booking.reasonCode || "BOOKING_FAILED", {
      userSafeSummary: booking.userSafeSummary || "I couldn't confirm the appointment request."
    });
    const status = booking.status === "confirmed" ? "confirmed" : "pending";
    return ok(status, booking.data || {}, {
      userSafeSummary: booking.status === "confirmed"
        ? booking.userSafeSummary || "The appointment is confirmed."
        : "The appointment request is pending confirmation."
    });
  }
  if (typeof context.store?.performDynamicAction !== "function") return fail("error", "DYNAMIC_ACTION_UNAVAILABLE");
  const digest = createHash("sha256").update(`${context.userId}|${name}|${context.sourceTurnId}`).digest("hex");
  const idempotencyKey = `dynamic:${name}:${digest}`;
  try {
    const result = await withTimeout(context.store.performDynamicAction(name, {
      userId: context.userId,
      sourceTurnId: context.sourceTurnId,
      idempotencyKey,
      args: safeArgs,
      consentState: context.consentState,
      allowedCapabilities: [...trustedCapabilities(context)],
      language: context.language || "english",
      intents: Array.isArray(context.intents) ? context.intents.filter((intent) => typeof intent === "string").slice(0, 8) : []
    }), timeoutFor(context));
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") return fail("error", "ACTION_RESULT_INVALID");
    if (!result.ok) return fail(result.status || "error", result.reasonCode || "ACTION_FAILED", {
      userSafeSummary: result.userSafeSummary || "I couldn't complete that action."
    });
    if (!["pending", "confirmed", "failed"].includes(result.status)) return fail("error", "ACTION_RESULT_INVALID");
    const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : {};
    const hasPersistenceIdentity = ["id", "receiptId", "receipt_id", "actionId", "action_id", "appointmentId"]
      .some((key) => isPlainString(data[key]));
    if (!hasPersistenceIdentity) return fail("pending", "PERSISTENCE_UNCONFIRMED", {
      userSafeSummary: "The request is pending confirmation."
    });
    if (result.status === "failed") return fail("error", "ACTION_FAILED", {
      userSafeSummary: result.userSafeSummary || "The requested action failed."
    });
    const summary = result.status === "pending" ? "Your request is pending confirmation."
      : result.status === "confirmed" ? "The requested action is confirmed."
        : "The requested action failed.";
    return ok(result.status, data, { userSafeSummary: summary });
  } catch {
    // A timeout may mean the gateway committed the action. Leave it pending;
    // never claim success or retry an uncertain write here.
    return fail("pending", "ACTION_OUTCOME_UNCERTAIN", { userSafeSummary: "The request is pending confirmation." });
  }
}

async function dynamicReadTool(name, args, context = {}) {
  const clean = validateDynamicReadArgs(name, args);
  if (!clean) return fail("invalid_input", "INVALID_LOOKUP_ARGUMENTS");
  const { kind } = DYNAMIC_READS[name];
  return lookupDynamic(kind, clean, context);
}

async function listCalendarSlots(args, context = {}) {
  if (args && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["start", "end"].includes(key)))) {
    return fail("invalid_input", "INVALID_LOOKUP_ARGUMENTS");
  }
  const result = await getBookingAvailability(args || {}, context);
  if (!result.ok) return fail(result.status, result.reasonCode, {
    userSafeSummary: "I can't confirm calendar availability right now.",
    modelObservation: { type: "dynamic_data", source: "trusted_calendar_read", kind: "calendarSlots", status: "error", records: [] }
  });
  const available = result.status === "available" || result.status === "suggestions";
  const records = result.status === "suggestions" && Array.isArray(result.data)
    ? result.data.slice(0, 3).map((slot) => ({ start: slot.start, end: slot.end, availability: "available", location: context.policy?.location || null, currency: null, vatTreatment: null, effectiveDate: null, lastUpdated: null, eligibility: null, timezone: context.policy?.timezone || null }))
    : result.status === "available" ? [{ ...result.data, availability: "available", location: context.policy?.location || null, currency: null, vatTreatment: null, effectiveDate: null, lastUpdated: null, eligibility: null, timezone: context.policy?.timezone || null }] : [];
  const status = available ? "found" : result.status === "unavailable" || result.status === "invalid_window" ? "unavailable" : "error";
  const observation = { type: "dynamic_data", source: "trusted_calendar_read", kind: "calendarSlots", status, records };
  return status === "error" ? fail("error", "CALENDAR_UNAVAILABLE", { modelObservation: observation })
    : ok(status, records, { userSafeSummary: available ? "Current calendar availability is available." : "No matching calendar slot is available.", modelObservation: observation });
}

function isPlainString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// --- searchApprovedKnowledge -------------------------------------------------
// Wraps the existing embed + knowledge-search path (src/ai.js embedText,
// store.searchKnowledge). Approval/freshness/review-status filtering happens
// server-side in the Edge Function/RPC (rafa_hybrid_search_knowledge /
// rafa_search_knowledge: `s.enabled and s.approved and d.review_status =
// 'approved'`, plus freshness), unchanged by this tool — this file never
// re-implements or loosens that filter, and a model-supplied argument can
// never select an unapproved/disabled/non-current row (the model never sees
// a document id to ask for one by).

// REFAL-AGENT-027 — explicit, bounded, model-safe evidence surface. This is
// the ONE place that decides what approved-knowledge content is safe/useful
// for the Agent decision model to see; agentDecision.js only ever reads this
// field (`modelObservation`), never a tool's raw `data`. Reused for every
// outcome (found/no_evidence/error) so the decision formatter has one
// uniform shape to look for regardless of status.
const MAX_RAG_EVIDENCE_ITEMS = 16;
const MAX_RAG_EVIDENCE_CONTENT_CHARS = 12000;
const MAX_RAG_EVIDENCE_TOTAL_CHARS = 18000;
const MAX_RAG_EVIDENCE_TITLE_CHARS = 160;
const MAX_RAG_EVIDENCE_SECTION_CHARS = 160;
const MAX_RAG_EVIDENCE_SOURCE_REF_CHARS = 80;

function safeField(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

// Search RPC and the Edge evidence resolver already verify the active source,
// approved revision, and revision expiry. Fact Register links and Evidence
// references are annotations; they do not decide whether approved indexed
// text can be read or cited in an answer. Finding aids remain search-only.
function isCustomerFacingKnowledgeChunk(row) {
  const kind = row?.chunk_kind ?? row?.chunkKind ?? row?.metadata?.kind;
  if (String(kind || "") === "aliases") return false;
  // The Edge search RPC already enforces these gates. Keep the Node boundary
  // defensive for alternate stores and offline callers: an explicit rejected
  // state must never be promoted to approved evidence. Missing workflow fields
  // remain acceptable because the trusted RPC may omit optional metadata.
  const reviewStatus = row?.review_status ?? row?.reviewStatus;
  if (reviewStatus != null && reviewStatus !== "approved") return false;
  if (row?.enabled === false || row?.active === false || row?.is_current === false || row?.isCurrent === false) return false;
  const validUntil = row?.valid_until ?? row?.validUntil;
  if (validUntil != null && String(validUntil).trim()) {
    const expiry = Date.parse(validUntil);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  }
  // Preserve an explicit owner block. Missing, pending, expired, or
  // language-limited register rows are not a second approval requirement for
  // an already approved Knowledge revision.
  const rows = Array.isArray(row?.policyMetadata?.factRegisterRows) ? row.policyMetadata.factRegisterRows : [];
  return !rows.some((fact) => fact?.status === "blocked");
}

// Builds the explicit "approved_knowledge" model observation from already
// trust-filtered search rows. Deliberately does NOT run the customer-input
// style `redactSensitiveData` label-proximity redaction on this content:
// Ticket 011 already found (and documented) that those patterns flag the
// mere MENTION of a credential type, which is the correct failure mode for
// untrusted customer input but would wrongly mangle genuine approved company
// content (e.g. "bank account details for a wire transfer", "IBAN format
// guidance") that has already been through human review/approval. The trust
// boundary here is the existing `review_status = 'approved'` filter, not a
// second text scrub.
function buildApprovedKnowledgeObservation(status, rows = [], { candidatePool = false } = {}) {
  const inputRows = Array.isArray(rows) ? rows : [];
  // The Edge search route expands each ranked hit to its complete parent
  // section. Reassemble ordered chunks into that section before applying the
  // model context budget, so conditions and exceptions travel with the fact.
  const groupedRows = [];
  const groupBySection = new Map();
  for (const row of inputRows) {
    const sectionIndex = row?.section_index;
    const groupKey = typeof row?.document_id === "string" && sectionIndex !== null && sectionIndex !== undefined
      ? `${row.document_id}:${sectionIndex}` : null;
    if (!groupKey) { groupedRows.push({ ...row, chunkIds: row?.chunk_id ? [row.chunk_id] : [] }); continue; }
    let group = groupBySection.get(groupKey);
    if (!group) {
      group = { ...row, content: "", chunkIds: [], policyMetadata: { ...(row.policyMetadata || {}), facts: [], supporting: [], governedFacts: [], factRegisterRows: [] } };
      groupBySection.set(groupKey, group);
      groupedRows.push(group);
    }
    if (row?.chunk_id) group.chunkIds.push(row.chunk_id);
    if (row?.content) group.content = group.content ? `${group.content}\n\n${row.content}` : String(row.content);
    for (const key of ["facts", "supporting", "governedFacts"]) {
      group.policyMetadata[key] = [...new Set([...(group.policyMetadata[key] || []), ...(Array.isArray(row?.policyMetadata?.[key]) ? row.policyMetadata[key] : [])])];
    }
    group.policyMetadata.factRegisterRows = [...new Map([...(group.policyMetadata.factRegisterRows || []), ...(Array.isArray(row?.policyMetadata?.factRegisterRows) ? row.policyMetadata.factRegisterRows : [])]
      .filter((fact) => fact?.id).map((fact) => [fact.id, fact])).values()];
  }
  const safeRows = groupedRows;
  const evidence = [];
  const policyEvidence = [];
  const factRegisterRows = new Map();
  let totalContentChars = 0;
  let truncated = safeRows.length > MAX_RAG_EVIDENCE_ITEMS;

  for (const row of safeRows) {
    if (!candidatePool && evidence.length >= MAX_RAG_EVIDENCE_ITEMS) {
      truncated = true;
      break;
    }
    const rawContent = String(row?.content || row?.heading || row?.source_name || "").trim();
    if (!rawContent) continue;
    const remainingBudget = candidatePool ? Infinity : MAX_RAG_EVIDENCE_TOTAL_CHARS - totalContentChars;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }
    // Never detach a claim from conditions at the end of its parent section.
    if (rawContent.length > MAX_RAG_EVIDENCE_CONTENT_CHARS || rawContent.length > remainingBudget) { truncated = true; continue; }
    const content = rawContent;
    const contentTruncated = false;
    totalContentChars += content.length;
    const trustedPolicy = row?.policyMetadata && typeof row.policyMetadata === "object" ? row.policyMetadata : {};
    // Governance metadata is trusted only after the server-side enrichment
    // lookup succeeds. Raw search rows (or future adapters) cannot authorize
    // hooks/comparisons by supplying their own topic/fact labels.
    const policyFacts = [...new Set([
      ...(Array.isArray(trustedPolicy.facts) ? trustedPolicy.facts : []),
      ...(Array.isArray(trustedPolicy.supporting) ? trustedPolicy.supporting : []),
      ...(Array.isArray(trustedPolicy.governedFacts) ? trustedPolicy.governedFacts : [])
    ])];
    const factIds = policyFacts.map((id) => String(id || "").trim())
      .filter((id) => /^MB-(?:F(?:[1-9]|[1-5][0-9]|6[0-6])|C[1-5]|J[0-4]|DYN[1-6])$/u.test(id)).slice(0, 24);
    const ref = safeField(row?.chunk_id || row?.document_id || row?.source_id, MAX_RAG_EVIDENCE_SOURCE_REF_CHARS);
    for (const fact of (Array.isArray(trustedPolicy.factRegisterRows) ? trustedPolicy.factRegisterRows : [])) {
      const id = String(fact?.id || "");
      if (/^MB-(?:F(?:[1-9]|[1-5][0-9]|6[0-6])|C[1-5]|J[0-4]|DYN[1-6])$/u.test(id)) factRegisterRows.set(id, fact);
    }
    evidence.push({
      title: safeField(row?.document_title || row?.source_name, MAX_RAG_EVIDENCE_TITLE_CHARS) || "Approved information",
      section: safeField(row?.heading, MAX_RAG_EVIDENCE_SECTION_CHARS),
      language: detectMessageLanguage(content),
      content,
      contentTruncated,
      // Opaque chunk/document identifiers only (never a reviewer name,
      // approval timestamp, or other workflow metadata) — safe for internal
      // source traceability, never customer/profile data.
      sourceRef: ref,
      sourceRefs: Array.isArray(row?.chunkIds) ? row.chunkIds.slice(0, 40) : (ref ? [ref] : []),
      relevance: Number(row?.selectionRelevance) || 1,
      selectionOrder: Number.isInteger(row?.selectionOrder) ? row.selectionOrder : evidence.length,
      retrievalRank: Number(row?.rank) || 0
    });
    policyEvidence.push({
      sourceRef: ref,
      review_status: trustedPolicy.reviewStatus === "approved" ? "approved" : row?.review_status === "approved" ? "approved" : null,
      valid_until: typeof trustedPolicy.validUntil === "string" ? trustedPolicy.validUntil.slice(0, 40) : typeof row?.valid_until === "string" ? row.valid_until.slice(0, 40) : null,
      metadata: { topic: safeField(trustedPolicy.topic, 80), facts: factIds }
    });
  }

  const pool = candidatePool ? { evidence, policyEvidence } : buildApprovedKnowledgeObservation(status, rows, { candidatePool: true });
  return { type: "approved_knowledge", status, evidence, candidateEvidence: pool.evidence.map((item) => ({ ...item })), truncated, policyEvidence, candidatePolicyEvidence: pool.policyEvidence.map((item) => ({ ...item })), factRegisterRows: [...factRegisterRows.values()] };
}

function knowledgeSectionIdentity(row, fallbackIndex) {
  const document = row?.document_id || row?.source_id;
  const section = row?.section_index ?? row?.metadata?.sectionIndex;
  if (document && section !== null && section !== undefined) return `${document}:${section}`;
  if (row?.chunk_id) return `chunk:${row.chunk_id}`;
  return `row:${fallbackIndex}`;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return null;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]); const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b; leftNorm += a * a; rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function mergeRankedKnowledgeResults(resultSets, { contextualCount = 1, historicalQueryIndex = -1, currentQueryIndex = -1 } = {}) {
  const sections = new Map();
  for (const [queryIndex, rows] of resultSets.entries()) {
    const seenInQuery = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const key = knowledgeSectionIdentity(row, index);
      if (!sections.has(key)) sections.set(key, { rows: [], contributions: [], firstSeen: sections.size, primaryMatch: false, historicalMatch: false, currentQueryRank: null });
      const group = sections.get(key);
      if (seenInQuery.has(key)) continue;
      seenInQuery.add(key);
      // The primary query expresses the current need. Related and original-
      // wording searches add coverage, but their repeated low-value hits must
      // not crowd a strong one-query result out of the bounded answer context.
      const queryWeight = queryIndex === 0 ? 4
        : queryIndex === historicalQueryIndex ? 8
          : queryIndex < contextualCount ? 4 : 1;
      // Preserve both leading results from the model's primary contextual
      // query: the first may establish the broad topic while the second holds
      // a needed condition. Complementary queries still contribute only their
      // top result so broad variants cannot crowd out current evidence.
      if ((queryIndex === 0 && index < 2)
        || (queryIndex > 0 && queryIndex < contextualCount && index === 0)
        || (queryIndex === currentQueryIndex && index === 0)) group.primaryMatch = true;
      if (queryIndex === historicalQueryIndex) group.historicalMatch = true;
      if (queryIndex === currentQueryIndex && (group.currentQueryRank === null || index < group.currentQueryRank)) group.currentQueryRank = index;
      group.contributions.push(queryWeight / (60 + index + 1));
      group.rows.push(...rows.filter((candidate) => {
        const candidateKey = knowledgeSectionIdentity(candidate, index);
        return candidateKey === key;
      }));
    }
  }
  return [...sections.values()].map((group) => {
    const strongest = Math.max(...group.contributions);
    const supporting = group.contributions.reduce((sum, value) => sum + value, 0) - strongest;
    // A second relevant query is useful corroboration. Cap its influence so
    // repeated generic matches cannot outrank a section that directly answers
    // the customer's question in the primary search.
    group.score = strongest + Math.min(strongest * 0.5, supporting * 0.2);
    return group;
  })
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .flatMap((group) => [...new Map(group.rows.map((row) => [row.chunk_id || `${row.document_id}:${row.chunk_index}`, row])).values()]
      .sort((a, b) => Number(a.chunk_index || 0) - Number(b.chunk_index || 0))
      .map((row) => ({ ...row, primarySearchMatch: group.primaryMatch, historicalSearchMatch: group.historicalMatch,
        currentQueryMatch: group.currentQueryRank !== null, currentQueryRank: group.currentQueryRank, selectionRelevance: group.score * 60 })));
}

async function searchApprovedKnowledge(args, { store, embedText, embeddingModel, matchCount = 6, language, currentMessage, user } = {}) {
  const query = isPlainString(args?.query) ? args.query.trim().slice(0, 1000) : "";
  if (!query) return fail("invalid_input", "QUERY_REQUIRED", { modelObservation: buildApprovedKnowledgeObservation("invalid_input", []) });
  if (typeof store?.searchKnowledge !== "function") return fail("error", "SEARCH_UNAVAILABLE", { modelObservation: buildApprovedKnowledgeObservation("error", []) });

  // Search returns finding-aid chunks and chunks whose fact-register gate may
  // reject them. Fetch a bounded candidate window so those rows do not crowd
  // approved answer evidence out of the requested result count.
  const requestedCount = Number.isInteger(matchCount) ? Math.min(MAX_RAG_EVIDENCE_ITEMS, Math.max(1, matchCount)) : 6;
  const candidateCount = Math.min(20, requestedCount * 3);

  const related = Array.isArray(args?.relatedQueries) ? args.relatedQueries.filter(isPlainString).map(value => value.trim().slice(0, 1000)).slice(0, 2) : [];
  const currentQuery = isPlainString(currentMessage) ? currentMessage.trim().slice(0, 1000) : "";
  const currentLanguage = detectMessageLanguage(currentQuery);
  const previousCustomerMessage = [...(Array.isArray(user?.history) ? user.history : [])].reverse()
    .map((turn) => typeof turn?.message === "string" ? turn.message.trim() : "")
    .find((message) => message && message !== currentQuery);
  const priorLanguage = previousCustomerMessage ? detectMessageLanguage(previousCustomerMessage) : "unknown";
  // A language switch can make a model-resolved English query miss the
  // approved section found by the customer's original Arabic or Greek wording.
  // Reuse only the immediately previous customer message, redact personal
  // data, and keep the extra retrieval bounded to this cross-language case.
  const crossLanguageHistoryQuery = previousCustomerMessage && priorLanguage !== currentLanguage
    && ["arabic", "english", "greek"].includes(priorLanguage) && ["arabic", "english", "greek"].includes(currentLanguage)
    ? redactPersonalData(previousCustomerMessage).slice(0, 1000).trim()
    : "";
  const contextualQueries = [...new Set([query, ...related, crossLanguageHistoryQuery])].filter(Boolean);
  let queries = [...new Set([...contextualQueries, currentQuery])].filter(Boolean);
  let historicalQueryIndex = crossLanguageHistoryQuery ? queries.indexOf(crossLanguageHistoryQuery) : -1;
  const searchPlans = await Promise.all(queries.map(async (searchQuery, index) => {
    let embedding = null;
    try {
      if (typeof embedText === "function") embedding = await embedText(searchQuery);
    } catch {
      // Embedding failure degrades to lexical-only search server-side; do not
      // fail the tool just because the local embedding pipeline is unavailable.
      embedding = null;
    }
    return { searchQuery, embedding, contextual: index < contextualQueries.length };
  }));
  const resolvedEmbedding = searchPlans[0]?.embedding;
  const currentIndex = queries.indexOf(currentQuery);
  const currentEmbedding = currentIndex >= 0 ? searchPlans[currentIndex]?.embedding : null;
  const currentAlignment = cosineSimilarity(resolvedEmbedding, currentEmbedding);
  const historyAlignment = historicalQueryIndex >= 0
    ? cosineSimilarity(resolvedEmbedding, searchPlans[historicalQueryIndex]?.embedding) : null;
  if (historicalQueryIndex >= 0 && currentIndex >= 0) {
    // The prior turn may resolve a cross-language follow-up, but a stale
    // previous topic must not outrank evidence for a clear current question.
    // When embeddings are unavailable, retain the legacy history search so
    // lexical-only retrieval remains compatible.
    if (historyAlignment !== null && currentAlignment !== null && historyAlignment < currentAlignment) {
      queries = queries.filter((_value, index) => index !== historicalQueryIndex);
      searchPlans.splice(historicalQueryIndex, 1);
      historicalQueryIndex = -1;
    }
  }
  const resultSets = await Promise.all(searchPlans.map(async ({ searchQuery, embedding, contextual }) => {
    try {
      const value = await store.searchKnowledge(searchQuery, embedding, embeddingModel || null, candidateCount);
      return { ok: true, value, contextual };
    } catch (error) {
      return { ok: false, error, contextual };
    }
  }));
  const successfulResults = resultSets.filter((result) => result.ok);
  if (!successfulResults.length) {
    const error = resultSets.find((result) => !result.ok)?.error;
    const providerErrorCode = /^[A-Z0-9_.-]{1,48}$/u.test(String(error?.code || "")) ? String(error.code) : null;
    const providerStatus = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
    const errorName = /^[A-Z][A-Za-z0-9]{0,39}$/u.test(String(error?.name || "")) ? String(error.name) : null;
    return fail("error", "RETRIEVAL_FAILED", {
      message: String(error?.message || error || "Knowledge retrieval failed.").slice(0, 200),
      modelObservation: buildApprovedKnowledgeObservation("error", []),
      trace: { searchQueries: queries, providerErrorCode, providerStatus, errorName }
    });
  }
  const results = successfulResults.length > 1
    ? mergeRankedKnowledgeResults(resultSets.map((result) => result.ok && Array.isArray(result.value) ? result.value : []), {
      contextualCount: resultSets.filter(result => result.contextual).length,
      historicalQueryIndex,
      currentQueryIndex: queries.indexOf(currentQuery)
    })
    : (Array.isArray(successfulResults[0].value) ? successfulResults[0].value : [])
      .map((row, index) => ({ ...row, selectionRelevance: 60 / (61 + index) }));

  // The RPC enforces source/document approval and expiry. Evidence/supporting
  // reference fields and Fact Register links are not admission requirements;
  // indexed chunk content remains usable when they are empty, general, or
  // stale. Finding aids are never customer evidence, even if a legacy RPC
  // returns one.
  const eligible = (Array.isArray(results) ? results : [])
    .filter(isCustomerFacingKnowledgeChunk);
  if (eligible.length === 0) {
    return ok("no_evidence", [], { userSafeSummary: "No approved information matched this question.", modelObservation: buildApprovedKnowledgeObservation("no_evidence", []), trace: { searchQueries: queries } });
  }

  const assemblyStarted = performance.now();
  const catalogue = [];
  const sectionRows = new Map();
  for (const [index, row] of eligible.entries()) {
    const key = knowledgeSectionIdentity(row, index);
    if (!sectionRows.has(key)) { sectionRows.set(key, []); catalogue.push({ sourceRef: row.chunk_id, title: row.document_title || row.source_name, section: row.heading, content: "", key }); }
    sectionRows.get(key).push(row);
  }
  for (const item of catalogue) item.content = sectionRows.get(item.key).map((row) => String(row.content || "")).join("\n\n");
  const visibleCatalogue = catalogue.slice(0, 40);
  const catalogueOmittedIds = catalogue.slice(40).map(item => item.sourceRef);
  // Search has already ranked these rows using semantic + lexical relevance.
  // Do not spend another model round trip re-selecting them: that call both
  // adds response latency and can discard a lower-ranked section that supplies
  // a condition or the other half of a multi-part answer. Keep the ranked
  // candidate window, then let the existing complete-section and prompt
  // budgets retain as many as fit for BOTH generation and validation.
  const prioritizedCatalogue = visibleCatalogue.map((item, index) => ({ item, index,
    primarySearchMatch: sectionRows.get(item.key).some((row) => row.primarySearchMatch === true) }))
    .sort((a, b) => Number(b.primarySearchMatch) - Number(a.primarySearchMatch) || a.index - b.index);
  const selectedRows = prioritizedCatalogue.flatMap(({ item }, selectionRank) => sectionRows.get(item.key)
    // Fusion scores depend on how many related searches were issued, so their
    // raw values are not comparable across separate tool calls. Rank within
    // this search round instead; accumulated-evidence budgeting can then
    // reliably let a better-ranked new section replace a weaker older one.
    .map((row) => ({ ...row,
      // Keep a relevant original-language history match distinguishable from
      // the current query; the history search is already gated by semantic
      // alignment when embeddings are available.
      selectionRelevance: 1 / (selectionRank + 1) + (row.historicalSearchMatch ? 1 : 0)
        // Preserve only the strongest few exact-wording matches so low-value
        // tail results cannot crowd out an already strong resolved overview.
        + (row.currentQueryMatch && Number(row.currentQueryRank) < 3 ? 1 / (Number(row.currentQueryRank) + 1) : 0),
      primarySearchMatch: row.primarySearchMatch === true,
      selectionOrder: selectionRank })));
  const modelObservation = buildApprovedKnowledgeObservation(selectedRows.length ? "found" : "no_evidence", selectedRows);
  modelObservation.primarySearchRefs = [...new Set(selectedRows.filter((row) => row.primarySearchMatch)
    .map((row) => row.chunk_id).filter((id) => typeof id === "string"))];
  const userSafeSummary = modelObservation.evidence.map((item) => String(item?.section || item?.title || "Approved information").slice(0, 120));
  return ok(selectedRows.length ? "found" : "no_evidence", selectedRows.slice(0, requestedCount), { userSafeSummary, modelObservation, trace: { searchQueries: queries, candidateCount: catalogue.length, candidateIds: catalogue.map((item) => item.sourceRef), catalogueOmittedIds, selectedCount: selectedRows.length, excludedIds: [], selectionStatus: "retrieval_ranked_bounded", evidenceAssemblyDurationMs: Math.round(performance.now() - assemblyStarted) } });
}

// --- getCustomerContext ------------------------------------------------------
// Takes the ALREADY-LOADED user object (never fetches again on its own — the
// bot/benchmark already loads the contact once per turn; a second internal
// fetch here would reintroduce the double-load race documented in
// docs/refal-agent-refactor-progress.md). Returns only a safe, flat subset.

function getCustomerContext(args, { user } = {}) {
  if (!user || typeof user !== "object") return fail("not_found", "CUSTOMER_NOT_LOADED");
  const state = getConversationState(user);
  const data = {
    language: user.profile?.language || null,
    knownFacts: state.agentFacts,
    crmCorrectionNeeded: state.crmCorrectionNeeded,
    consent: state.consent,
    noProactiveBookingOrContact: state.noProactiveBookingOrContact,
    hasOpenHandover: state.handover.required,
    existingClientVerified: state.existingClient.authenticated
  };
  return ok("found", data);
}

// --- saveCustomerFact ---------------------------------------------------------
// Code authorizes WHAT may be saved (field shape, value type, provenance),
// never the model. Provenance must be "customer_message" — this tool refuses
// to persist a model guess or inference as if the customer stated it
// (see Phase 7 rule: do not convert assumptions into customer-provided facts).

const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const ALLOWED_PROVENANCE = new Set(["customer_message"]);
const ALLOWED_VALUE_TYPES = new Set(["string", "number", "boolean"]);

async function saveCustomerFact(args, { store, userId, currentMessage, sourceTurnId } = {}) {
  const field = args?.field;
  const value = args?.value;
  const provenance = args?.provenance;

  if (!FIELD_NAME_RE.test(String(field || ""))) return fail("invalid_input", "INVALID_FIELD_NAME");
  // Normalize to the canonical (lowercase) key before it is ever used to read
  // or write — validating the raw casing but storing/looking up under the
  // original would silently fragment the same logical fact across
  // differently-cased keys (e.g. "companyActivity" vs "companyactivity").
  const canonicalField = String(field).toLowerCase();
  if (!ALLOWED_VALUE_TYPES.has(typeof value) || (typeof value === "string" && (!value.trim() || value.length > 500))) {
    return fail("invalid_input", "INVALID_VALUE");
  }
  if (!ALLOWED_PROVENANCE.has(provenance)) return fail("not_authorized", "INVALID_PROVENANCE");
  // The model can propose a value, but cannot establish that the customer
  // said it. Verify it against the trusted inbound turn and persist a turn
  // reference. This keeps a model guess out of memory and the never-reask gate.
  const evidence = extractLiteralEvidence(currentMessage, value);
  if (!evidence || !sourceTurnId) return fail("not_authorized", "UNVERIFIED_CUSTOMER_VALUE");
  if (isNegatedLiteralMention(currentMessage, value)) return fail("not_authorized", "NON_AFFIRMATIVE_CUSTOMER_VALUE");
  const rawCustomerValue = extractLiteralSpan(currentMessage, value);
  if (!rawCustomerValue) return fail("not_authorized", "UNVERIFIED_CUSTOMER_VALUE");
  const crmField = Object.keys(CRM_FIELDS).find((candidate) => candidate.toLowerCase() === canonicalField)
    || (canonicalField === "companyactivity" ? "businessActivity" : null);
  if (!crmField) return fail("not_authorized", "UNSUPPORTED_CRM_FIELD");
  const candidate = crmField ? normalizeCrmCandidate({
    field: crmField,
    value: String(value),
    rawValue: rawCustomerValue,
    provenance: CUSTOMER_PROVENANCE,
    confidence: 1,
    sourceTurnId: String(sourceTurnId),
    evidence,
    selfIdentified: crmField === "name" && isSelfIdentifiedName(currentMessage, rawCustomerValue)
  }) : null;
  if (crmField && !candidate?.ok) return fail("not_authorized", candidate?.reason === "name_not_self_identified" ? "NAME_NOT_SELF_IDENTIFIED" : "INVALID_CRM_CANDIDATE");
  const storedValue = candidate.record.normalizedValue;
  const safeEvidence = candidate.record.evidence;
  if (typeof store?.saveCrmProfile === "function") {
    try {
      const result = await store.saveCrmProfile({ userId, field: crmField, rawValue: candidate.record.rawValue, normalizedValue: storedValue, sourceTurnId: String(sourceTurnId) });
      if (result?.status === "correction_needed") {
        return ok("correction_needed", { field: canonicalField, correctionNeeded: true });
      }
      if (result?.status !== "saved") return fail("error", "SAVE_FAILED");
      return ok("saved", { field: canonicalField });
    } catch {
      return fail("error", "SAVE_FAILED");
    }
  }
  if (!userId || typeof store?.updateUser !== "function") return fail("error", "STORE_UNAVAILABLE");

  let correctionNeeded = false;
  try {
    await store.updateUser(userId, (draft) => {
      draft.profile = draft.profile || {};
      draft.profile.agentFacts = { ...(draft.profile.agentFacts || {}) };
      const current = draft.profile.agentFacts[canonicalField];
      const priorCorrection = draft.profile.crmCorrectionNeeded;
      const pendingFields = Array.isArray(priorCorrection?.fields)
        ? priorCorrection.fields.map((field) => String(field).toLowerCase())
        : priorCorrection?.field ? [String(priorCorrection.field).toLowerCase()] : [];
      const resolvesPendingCorrection = pendingFields.includes(canonicalField)
        && isExplicitCorrectionMessage(currentMessage);
      if (current && resolvesPendingCorrection) {
        draft.profile.agentFacts[canonicalField] = {
          ...candidate.record, value: storedValue, provenance,
          sourceTurnId: String(sourceTurnId), evidence: safeEvidence, savedAt: new Date().toISOString()
        };
        draft.profile.agentFacts[canonicalField].correctionNeeded = false;
        const remainingFields = pendingFields.filter((field) => field !== canonicalField);
        for (const field of remainingFields) {
          if (draft.profile.agentFacts[field]) draft.profile.agentFacts[field] = { ...draft.profile.agentFacts[field], correctionNeeded: true };
        }
        if (remainingFields.length) {
          draft.profile.crmCorrectionNeeded = { ...priorCorrection, field: remainingFields[0], fields: remainingFields };
        } else {
          delete draft.profile.crmCorrectionNeeded;
        }
        return;
      }
      if (current && normalizeForComparison(current.value ?? current.normalizedValue ?? "") !== normalizeForComparison(storedValue)) {
        // Never silently replace a different stated value. Leave the prior
        // record intact and request a clarification in the conversation.
        const fields = [...new Set([...pendingFields, canonicalField])].sort();
        draft.profile.crmCorrectionNeeded = {
          ...(priorCorrection || {}),
          field: fields[0],
          fields,
          sourceTurnId: String(sourceTurnId),
          proposedValue: storedValue,
          recordedAt: new Date().toISOString()
        };
        draft.profile.agentFacts[canonicalField] = { ...current, correctionNeeded: true };
        correctionNeeded = true;
        return;
      }
      draft.profile.agentFacts[canonicalField] = {
        ...candidate.record,
        value: storedValue, provenance, sourceTurnId: String(sourceTurnId),
        evidence: safeEvidence, savedAt: new Date().toISOString()
      };
    });
  } catch (error) {
    return fail("error", "SAVE_FAILED", { message: String(error?.message || error).slice(0, 200) });
  }
  return ok(correctionNeeded ? "correction_needed" : "saved", correctionNeeded
    ? { field: canonicalField, correctionNeeded: true }
    : { field: canonicalField });
}

// --- proposeHandover -----------------------------------------------------------
// Authorization check only. This tool never persists a handover — persistence
// stays exactly where it already happens deterministically today
// (messageRouter.js recordHistory -> store.createHandover), so this refactor
// does not open a second, less-audited write path for the same action. The
// Agent can ask "would a handover be authorized right now," receive the
// built (but unpersisted) summary, and then the existing deterministic path
// is what actually creates it.

async function proposeHandover(args, { user, intents = [], language } = {}) {
  if (!user || typeof user !== "object") return fail("not_found", "CUSTOMER_NOT_LOADED");
  const consentStatus = getConsentState({ user, history: user.history || [] });
  if (consentStatus !== "granted") {
    return fail("not_authorized", "CONSENT_REQUIRED", { consentStatus: consentStatus || "unknown" });
  }
  const handover = createHandover({
    input: args?.reason || "",
    customer: { name: user.profile?.name, whatsappContact: user.id, language },
    intent: intents,
    need: args?.reason || ""
  });
  return ok("authorized", handover);
}

const TOOL_REGISTRY = Object.freeze({
  lookupActiveOffer: {
    description: "Read current approved live offer records for offer-specific price, validity, availability, and terms. Do not use this instead of searchApprovedKnowledge for general company service scope, package descriptions, or process details. If the customer asks for both service facts and a live offer price or term, search approved knowledge for the service facts and use this tool only for the live offer detail. Pass the exact database code when known; otherwise use empty args to discover up to four current offers. Never send a display title as a code.",
    run: (args, context) => dynamicReadTool("lookupActiveOffer", args, context)
  },
  lookupRenewalFees: {
    description: "Read the current approved renewal fee for a specific item. Missing or expired values are unconfirmed.",
    run: (args, context) => dynamicReadTool("lookupRenewalFees", args, context)
  },
  searchPropertyInventory: {
    description: "Search current approved and available property inventory using explicit filters. Never infer eligibility or availability.",
    run: (args, context) => dynamicReadTool("searchPropertyInventory", args, context)
  },
  lookupReservationRules: {
    description: "Read the current reservation rule for an exact project or property identifier.",
    run: (args, context) => dynamicReadTool("lookupReservationRules", args, context)
  },
  lookupGovernmentFees: {
    description: "Read a current approved government fee by fee type. Do not combine it into a total transaction cost.",
    run: (args, context) => dynamicReadTool("lookupGovernmentFees", args, context)
  },
  listCalendarSlots: {
    description: "Read current calendar availability or up to three current suggested slots using the configured booking system.",
    run: listCalendarSlots
  },
  upsertLead: {
    description: "Save customer-provided lead fields for the trusted current contact and source turn. This never sends a message.",
    run: (args, context) => performDynamicAction("upsertLead", args, context)
  },
  createHandover: {
    description: "Persist a purpose-bound specialist handover only when the trusted caller authorizes this handover request or escalation.",
    run: (args, context) => performDynamicAction("createHandover", args, context)
  },
  holdOrBookAppointment: {
    description: "Request the exact appointment the trusted caller has confirmed with the customer. Pending review is not a confirmed booking.",
    run: (args, context) => performDynamicAction("holdOrBookAppointment", args, context)
  },
  scheduleFollowUp: {
    description: "Schedule a future follow-up only with current follow-up consent and trusted authorization. Scheduling does not mean a message was sent.",
    run: (args, context) => performDynamicAction("scheduleFollowUp", args, context)
  },
  recordComplianceEvent: {
    description: "Create a minimal internal compliance event. This does not authorize customer contact or outbound messages.",
    run: (args, context) => performDynamicAction("recordComplianceEvent", args, context)
  },
  searchApprovedKnowledge: {
    description: "Search authorized current knowledge. Arguments: query (string), optional relatedQueries (up to two complementary model-generated query strings). Resolve the current need and its relationships from history. Use a broad company-capability query only when the customer asks what REFAL offers or whether REFAL provides a service. For a direct factual question about a relationship or outcome, search that relationship and its conditions; add a company-capability query only if the customer also asks about REFAL's role. For a summary across earlier turns, keep query a concise service overview; use relatedQueries only for distinct unresolved specifics from customer history, never repeat the full conversation in a query. Use relatedQueries for distinct missing evidence needs, not repeated paraphrases. A topic description is not proof of a company's service. Combine relevant searches in one tool call rather than repeating searches.",
    run: searchApprovedKnowledge
  },
  getCustomerContext: {
    description: "Read already-known customer facts, language, and consent/workflow state. Use before asking a question that might already be answered.",
    run: getCustomerContext
  },
  saveCustomerFact: {
    description: "Record a fact the customer just stated directly in this conversation. Never use for a guess or assumption.",
    run: saveCustomerFact
  },
  proposeHandover: {
    description: "Check whether a specialist handover is currently authorized (requires the customer's prior consent). Does not contact the customer by itself.",
    run: proposeHandover
  },
  // REFAL-AGENT-009 — booking tools. Implemented in agentBookingTools.js to
  // keep this file readable, but merged into THIS registry object: there is
  // exactly one registry, the one agentDecision.js/agentLoop.js consume.
  getBookingAvailability: {
    description: "Check whether a specific proposed meeting slot is free, or ask for the next available meeting times. Read-only: it never books anything.",
    run: getBookingAvailability
  },
  requestBookingAction: {
    description: "Request an actual appointment for a specific slot the customer agreed to. Only the returned result proves what happened; never tell the customer a meeting is booked unless this tool reported it confirmed.",
    run: requestBookingAction
  }
});

module.exports = {
  ok,
  fail,
  TOOL_REGISTRY,
  searchApprovedKnowledge,
  getCustomerContext,
  saveCustomerFact,
  proposeHandover,
  getBookingAvailability,
  requestBookingAction,
  dynamicReadTool,
  performDynamicAction,
  listCalendarSlots,
  isFreshDynamicRow,
  dynamicRecord,
  buildApprovedKnowledgeObservation,
  MAX_RAG_EVIDENCE_ITEMS,
  MAX_RAG_EVIDENCE_CONTENT_CHARS,
  MAX_RAG_EVIDENCE_TOTAL_CHARS
};
