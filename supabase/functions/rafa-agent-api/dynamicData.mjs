// M4 private dynamic-data gateway. All names are allow-listed so request data
// can select values but never identifiers, filters, columns, or SQL fragments.
export const DYNAMIC_TABLES = Object.freeze({
  offers: "refal_offers_and_pricing",
  renewals: "refal_annual_renewal_fees",
  properties: "refal_property_inventory",
  reservations: "refal_reservation_rules",
  governmentFees: "refal_government_fees"
});

const FILTERS = Object.freeze({
  offers: { code: "code" },
  renewals: { item: "item" },
  properties: { city: "city", type: "type", status: "status", reference: "reference" },
  reservations: { projectOrPropertyId: "project_or_property_id" },
  governmentFees: { feeType: "fee_type" }
});

class HttpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function invalid(message, statusCode = 400) { throw new HttpError(message, statusCode); }

export async function listDynamicData(client, kind, filters = {}, now = new Date()) {
  const table = DYNAMIC_TABLES[kind];
  if (!table) invalid("Unsupported dynamic data kind.");
  const admin = filters.view === "admin";
  let query = client.from(table).select("*").order("effective_from", { ascending: false }).limit(100);

  if (!admin) {
    query = query.eq("active", true).eq("review_status", "approved")
      .lte("effective_from", now.toISOString()).gt("valid_until", now.toISOString());
    if (kind === "offers" && filters.code === "formation-package") {
      // Keep the migration's deliberately fixed source approval date from
      // being renewed by replaying SQL; price still expires on its own date.
      query = query.lte("verified_at", now.toISOString()).lte("valid_until", new Date(Date.parse("2026-10-07T00:00:00Z") + 30 * 86400000).toISOString());
    } else query = query.lte("verified_at", now.toISOString());
    if (kind === "properties") query = query.eq("available", true);
  }

  for (const [input, column] of Object.entries(FILTERS[kind])) {
    const value = filters[input];
    if (value !== undefined && value !== null && String(value).trim()) {
      const normalized = String(value).trim().slice(0, 120);
      query = query.eq(column, normalized);
    }
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return { rows, status: rows.length ? "available" : "unavailable", reasonCode: rows.length ? null : "NO_CURRENT_DATA" };
}

export async function mutateDynamicData(client, kind, body = {}) {
  if (!DYNAMIC_TABLES[kind]) invalid("Unsupported dynamic data kind.");
  const operation = String(body.operation || "");
  if (!["create", "update", "delete"].includes(operation)) invalid("Unsupported dynamic data operation.");
  const actor = String(body.actor || "").trim();
  const reason = String(body.reason || "").trim();
  if (!actor || actor.length > 200 || !reason || reason.length > 500) invalid("A trusted operator and change reason are required.");
  const id = body.id || null;
  if (operation === "create" && id !== null) invalid("Create must not provide an id.");
  if (operation !== "create" && !/^[0-9a-f-]{36}$/i.test(String(id || ""))) invalid("A valid row id is required.");
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) invalid("A typed data object is required.");
  const { data: row, error } = await client.rpc("refal_mutate_dynamic_data", {
    p_kind: kind,
    p_operation: operation,
    p_id: id,
    p_data: data,
    p_actor: actor,
    p_reason: reason
  });
  if (error) {
    if (["P0002", "PGRST116"].includes(error.code)) invalid("Dynamic data row was not found.", 404);
    throw error;
  }
  if (!row || typeof row !== "object") invalid("Dynamic data mutation was not confirmed.", 502);
  return row;
}

const DYNAMIC_ACTIONS = new Set(["upsertLead", "createHandover", "scheduleFollowUp", "recordComplianceEvent"]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestHash(value) {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Claim-before-effect makes retries safe across restarts. A pending duplicate
// is intentionally not re-executed: an external or partially completed action
// must be reconciled before a new idempotency key is used.
export async function performDynamicAction(client, name, body, execute) {
  if (!DYNAMIC_ACTIONS.has(name)) invalid("Unsupported dynamic action.");
  const userId = String(body?.userId || "").trim();
  const key = String(body?.idempotencyKey || "").trim();
  const sourceTurnId = String(body?.sourceTurnId || "").trim();
  if (!userId || userId.length > 200 || !key || key.length > 200 || !/^[0-9a-f-]{36}$/i.test(sourceTurnId)) {
    invalid("A customer, source turn and idempotency key are required.");
  }
  if (!body.args || typeof body.args !== "object" || Array.isArray(body.args)) invalid("A bounded action object is required.");
  if (JSON.stringify(body.args).length > 4000) invalid("The action details are too large.", 413);
  const hash = await requestHash({ name, userId, sourceTurnId, args: body.args });
  const claimed = await client.rpc("refal_claim_dynamic_action", {
    p_contact_id: body.contactId,
    p_tool: name,
    p_idempotency_key: key,
    p_request_hash: hash,
    p_source_turn_id: sourceTurnId
  });
  if (claimed.error) {
    if (claimed.error.code === "P0001" && String(claimed.error.message || "").includes("M4 action rate limit")) invalid("Please wait before repeating this request.", 429);
    throw claimed.error;
  }
  const receipt = claimed.data || {};
  if (receipt.claimed !== true) {
    return { status: receipt.state || "pending", result: receipt.result || null, duplicate: true, receiptId: receipt.receipt_id || null };
  }
  let result;
  try { result = await execute(); }
  catch (error) {
    // Handler-level validation/auth rejection is definitive: it occurs before
    // the action persistence call. Record that terminal state so a duplicate
    // does not remain "pending" forever. Unknown/network/database failures can
    // occur after an effect and must stay pending for reconciliation.
    const statusCode = Number(error?.statusCode);
    if (error?.name === "HttpError" && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
      const completion = await client.rpc("refal_finish_dynamic_action", {
        p_receipt_id: receipt.receipt_id,
        p_contact_id: body.contactId,
        p_request_hash: hash,
        p_state: "failed",
        p_result: { reasonCode: "ACTION_REJECTED", userSafeSummary: "I couldn't complete that request." }
      });
      if (!completion.error && completion.data?.state === "failed") {
        return { status: "failed", result: completion.data.result || null, duplicate: false, receiptId: receipt.receipt_id, reasonCode: "ACTION_REJECTED", userSafeSummary: "I couldn't complete that request." };
      }
      return { status: "pending", result: null, duplicate: false, receiptId: receipt.receipt_id, reasonCode: "RECEIPT_UNCONFIRMED" };
    }
    // The adapter may have reached persistence before the transport failed.
    // Keep the durable receipt pending until reconciliation proves the effect.
    return { status: "pending", result: null, duplicate: false, receiptId: receipt.receipt_id, reasonCode: "ACTION_UNCERTAIN" };
  }
  if (!result || typeof result !== "object" || !result.id) {
    return { status: "pending", result: null, duplicate: false, receiptId: receipt.receipt_id, reasonCode: "PERSISTENCE_UNCONFIRMED" };
  }
  const completion = await client.rpc("refal_finish_dynamic_action", {
    p_receipt_id: receipt.receipt_id,
    p_contact_id: body.contactId,
    p_request_hash: hash,
    p_state: "confirmed",
    p_result: { id: result.id, status: result.status || "confirmed", userSafeSummary: String(result.userSafeSummary || "Saved.").slice(0, 240) }
  });
  if (completion.error || completion.data?.state !== "confirmed") {
    return { status: "pending", result: null, duplicate: false, receiptId: receipt.receipt_id, reasonCode: "RECEIPT_UNCONFIRMED" };
  }
  return { status: "confirmed", result, duplicate: false, receiptId: receipt.receipt_id };
}
