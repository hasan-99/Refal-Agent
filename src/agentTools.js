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
// server-side in the Edge Function, unchanged by this tool.

async function searchApprovedKnowledge(args, { store, embedText, embeddingModel, matchCount = 6 } = {}) {
  const query = isPlainString(args?.query) ? args.query.trim().slice(0, 1000) : "";
  if (!query) return fail("invalid_input", "QUERY_REQUIRED");
  if (typeof store?.searchKnowledge !== "function") return fail("error", "SEARCH_UNAVAILABLE");

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
    return fail("error", "RETRIEVAL_FAILED", { message: String(error?.message || error).slice(0, 200) });
  }

  const evidence = Array.isArray(results) ? results : [];
  if (evidence.length === 0) {
    return ok("no_evidence", [], { userSafeSummary: "No approved information matched this question." });
  }

  const userSafeSummary = evidence.slice(0, matchCount).map((item) => String(item?.heading || item?.source_name || "Approved information").slice(0, 120));
  return ok("found", evidence, { userSafeSummary });
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
    description: "Search approved REFALCO knowledge for current prices, services, or company facts. Use when the customer's current question needs a factual answer, not for greetings or clarifications.",
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
  requestBookingAction
};
