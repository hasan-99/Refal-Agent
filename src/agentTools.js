// Deterministic tool layer for the Agent orchestration loop (see agentLoop.js).
//
// The model may PROPOSE calling one of these tools with arguments; this file
// is the code that VALIDATES and EXECUTES. No tool here trusts a model-
// generated id blindly, writes outside an explicit allowlist, or bypasses an
// existing deterministic boundary (consent, privacy, knowledge approval).
// Tools wrap existing services (leadQualification, handover, supabaseStore)
// rather than reimplementing them.

const { getConsentState } = require("./leadQualification");
const { createHandover } = require("./handover");
const { getConversationState } = require("./conversationState");
const { ok, fail } = require("./agentToolResult");
const { getBookingAvailability, requestBookingAction } = require("./agentBookingTools");

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
    evidence.push({
      title: safeField(row?.document_title || row?.source_name, MAX_RAG_EVIDENCE_TITLE_CHARS) || "Approved information",
      section: safeField(row?.heading, MAX_RAG_EVIDENCE_SECTION_CHARS),
      content,
      contentTruncated,
      // Opaque chunk/document identifiers only (never a reviewer name,
      // approval timestamp, or other workflow metadata) — safe for internal
      // source traceability, never customer/profile data.
      sourceRef: safeField(row?.chunk_id || row?.document_id || row?.source_id, MAX_RAG_EVIDENCE_SOURCE_REF_CHARS)
    });
  }

  return { type: "approved_knowledge", status, evidence, truncated };
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
  buildApprovedKnowledgeObservation,
  MAX_RAG_EVIDENCE_ITEMS,
  MAX_RAG_EVIDENCE_CONTENT_CHARS,
  MAX_RAG_EVIDENCE_TOTAL_CHARS
};
