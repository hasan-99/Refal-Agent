// Deterministic tool layer for the Agent orchestration loop (see agentLoop.js).
//
// The model may PROPOSE calling one of these tools with arguments; this file
// is the code that VALIDATES and EXECUTES. No tool here trusts a model-
// generated id blindly, writes outside an explicit allowlist, or bypasses an
// existing deterministic boundary (consent, privacy, knowledge approval).
// Tools wrap existing services (leadQualification, handover, supabaseStore)
// rather than reimplementing them.

const { createHash } = require("node:crypto");

const { getConsentState } = require("./leadQualification");
const { createHandover } = require("./handover");
const { getConversationState } = require("./conversationState");
const { ok, fail } = require("./agentToolResult");
const { getBookingAvailability, requestBookingAction } = require("./agentBookingTools");

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
const MAX_RAG_EVIDENCE_ITEMS = 4;
const MAX_RAG_EVIDENCE_CONTENT_CHARS = 500;
const MAX_RAG_EVIDENCE_TOTAL_CHARS = 1600;
const MAX_RAG_EVIDENCE_TITLE_CHARS = 160;
const MAX_RAG_EVIDENCE_SECTION_CHARS = 160;
const MAX_RAG_EVIDENCE_SOURCE_REF_CHARS = 80;

function safeField(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
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
function buildApprovedKnowledgeObservation(status, rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const evidence = [];
  const policyEvidence = [];
  const factRegisterRows = new Map();
  let totalContentChars = 0;
  let truncated = safeRows.length > MAX_RAG_EVIDENCE_ITEMS;

  for (const row of safeRows) {
    if (evidence.length >= MAX_RAG_EVIDENCE_ITEMS) {
      truncated = true;
      break;
    }
    const rawContent = String(row?.content || row?.heading || row?.source_name || "").trim();
    if (!rawContent) continue;
    const remainingBudget = MAX_RAG_EVIDENCE_TOTAL_CHARS - totalContentChars;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }
    const perItemLimit = Math.min(MAX_RAG_EVIDENCE_CONTENT_CHARS, remainingBudget);
    const content = rawContent.slice(0, perItemLimit);
    const contentTruncated = rawContent.length > content.length;
    totalContentChars += content.length;
    const trustedPolicy = row?.policyMetadata && typeof row.policyMetadata === "object" ? row.policyMetadata : {};
    // Governance metadata is trusted only after the server-side enrichment
    // lookup succeeds. Raw search rows (or future adapters) cannot authorize
    // hooks/comparisons by supplying their own topic/fact labels.
    const policyFacts = Array.isArray(trustedPolicy.facts) ? trustedPolicy.facts : [];
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
      content,
      contentTruncated,
      // Opaque chunk/document identifiers only (never a reviewer name,
      // approval timestamp, or other workflow metadata) — safe for internal
      // source traceability, never customer/profile data.
      sourceRef: ref
    });
    policyEvidence.push({
      sourceRef: ref,
      review_status: trustedPolicy.reviewStatus === "approved" ? "approved" : row?.review_status === "approved" ? "approved" : null,
      valid_until: typeof trustedPolicy.validUntil === "string" ? trustedPolicy.validUntil.slice(0, 40) : typeof row?.valid_until === "string" ? row.valid_until.slice(0, 40) : null,
      metadata: { topic: safeField(trustedPolicy.topic, 80), facts: factIds }
    });
  }

  return { type: "approved_knowledge", status, evidence, truncated, policyEvidence, factRegisterRows: [...factRegisterRows.values()] };
}

async function searchApprovedKnowledge(args, { store, embedText, embeddingModel, matchCount = 6 } = {}) {
  const query = isPlainString(args?.query) ? args.query.trim().slice(0, 1000) : "";
  if (!query) return fail("invalid_input", "QUERY_REQUIRED", { modelObservation: buildApprovedKnowledgeObservation("invalid_input", []) });
  if (typeof store?.searchKnowledge !== "function") return fail("error", "SEARCH_UNAVAILABLE", { modelObservation: buildApprovedKnowledgeObservation("error", []) });

  let embedding = null;
  try {
    if (typeof embedText === "function") embedding = await embedText(query);
  } catch {
    // Embedding failure degrades to lexical-only search server-side; do not
    // fail the tool just because the local embedding pipeline is unavailable.
    embedding = null;
  }

  let results;
  try {
    results = await store.searchKnowledge(query, embedding, embeddingModel || null, matchCount);
  } catch (error) {
    return fail("error", "RETRIEVAL_FAILED", { message: String(error?.message || error).slice(0, 200), modelObservation: buildApprovedKnowledgeObservation("error", []) });
  }

  const evidence = Array.isArray(results) ? results : [];
  if (evidence.length === 0) {
    return ok("no_evidence", [], { userSafeSummary: "No approved information matched this question.", modelObservation: buildApprovedKnowledgeObservation("no_evidence", []) });
  }

  const userSafeSummary = evidence.slice(0, matchCount).map((item) => String(item?.heading || item?.source_name || "Approved information").slice(0, 120));
  return ok("found", evidence, { userSafeSummary, modelObservation: buildApprovedKnowledgeObservation("found", evidence) });
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

async function saveCustomerFact(args, { store, userId } = {}) {
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
  if (!userId || typeof store?.updateUser !== "function") return fail("error", "STORE_UNAVAILABLE");

  try {
    await store.updateUser(userId, (draft) => {
      draft.profile = draft.profile || {};
      draft.profile.agentFacts = { ...(draft.profile.agentFacts || {}) };
      draft.profile.agentFacts[canonicalField] = { value, provenance, savedAt: new Date().toISOString() };
    });
  } catch (error) {
    return fail("error", "SAVE_FAILED", { message: String(error?.message || error).slice(0, 200) });
  }
  return ok("saved", { field: canonicalField, value });
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
    description: "Read currently approved, effective offers. Pass the exact database code when known. If no exact code is present in the conversation or approved knowledge, call with empty args to discover up to four current offers. Never send a display title as a code. Use only returned data for price or inclusions.",
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
    description: "Search approved Refalco Group knowledge for current prices, services, or company facts. Use when the customer's current question needs a factual answer, not for greetings or clarifications.",
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
