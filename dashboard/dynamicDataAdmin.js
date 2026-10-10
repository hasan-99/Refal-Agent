const KIND_SCHEMAS = Object.freeze({
  offers: {
    fields: new Set(["code", "title_en", "title_ar", "title_el", "amount", "currency", "vat_note", "inclusions", "valid_from", "effective_from", "valid_until", "active", "review_status", "location", "eligibility", "source_note"]),
    required: ["code", "title_en", "amount", "valid_from", "effective_from", "valid_until", "source_note"],
    labels: { amount: "Offer amount" }
  },
  renewals: {
    fields: new Set(["item", "amount", "currency", "period", "notes_en", "notes_ar", "notes_el", "effective_from", "valid_until", "active", "review_status", "location", "eligibility", "vat_note", "source_note"]),
    required: ["item", "amount", "period", "effective_from", "valid_until", "source_note"],
    labels: { amount: "Renewal fee" }
  },
  properties: {
    fields: new Set(["reference", "city", "type", "status", "price", "currency", "vat_rate_note", "bedrooms", "first_sale", "pr_eligible", "available", "developer", "delivery_date", "effective_from", "valid_until", "active", "review_status", "location", "eligibility", "vat_note", "source_note"]),
    required: ["reference", "city", "type", "status", "price", "effective_from", "valid_until", "source_note"],
    labels: { price: "Property price" }
  },
  reservations: {
    fields: new Set(["project_or_property_id", "deposit_amount", "deposit_percent", "currency", "refundable", "conditions_en", "conditions_ar", "conditions_el", "effective_from", "valid_until", "active", "review_status", "location", "eligibility", "vat_note", "source_note"]),
    required: ["project_or_property_id", "effective_from", "valid_until", "source_note"],
    labels: { deposit_amount: "Deposit amount", deposit_percent: "Deposit percentage" }
  },
  governmentFees: {
    fields: new Set(["fee_type", "amount", "currency", "authority", "effective_from", "valid_until", "active", "review_status", "location", "eligibility", "vat_note", "source_note"]),
    required: ["fee_type", "amount", "authority", "effective_from", "valid_until", "source_note"],
    labels: { amount: "Government fee" }
  }
});

const MISSING_OBJECT_CODES = new Set(["42P01", "42883", "PGRST202", "PGRST205"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerDynamicDataAdminRoutes(app, { requireAdmin, fetchImpl = fetch, env = process.env, now = () => new Date() } = {}) {
  if (!app?.get || !app?.post || !app?.patch || !app?.delete || typeof requireAdmin !== "function") {
    throw new TypeError("An Express app and requireAdmin middleware are required.");
  }

  app.get("/api/dynamic-data/:kind", async (req, res) => {
    const schema = KIND_SCHEMAS[req.params.kind];
    if (!schema) return res.status(400).json({ error: "Unsupported commercial data kind." });
    try {
      const result = await callGateway("GET", req.params.kind, null, { fetchImpl, env });
      if (!Array.isArray(result?.rows)) throw unavailableError();
      return res.json({ rows: result.rows, status: result.status || "ok" });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/dynamic-data/:kind", requireAdmin, async (req, res) => {
    const schema = KIND_SCHEMAS[req.params.kind];
    if (!schema) return res.status(400).json({ error: "Unsupported commercial data kind." });
    try {
      const actor = trustedActor(req);
      const data = validateData(req.body?.data, schema, { operation: "create", actor, now: now() });
      const reason = validateReason(req.body?.reason);
      const result = await callGateway("POST", req.params.kind, { operation: "create", data, actor, reason }, { fetchImpl, env });
      if (!result?.row) return res.status(404).json({ error: "The commercial data row was not created." });
      return res.status(201).json({ row: result.row });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.patch("/api/dynamic-data/:kind", requireAdmin, async (req, res) => {
    const schema = KIND_SCHEMAS[req.params.kind];
    if (!schema) return res.status(400).json({ error: "Unsupported commercial data kind." });
    try {
      const actor = trustedActor(req);
      const id = validateId(req.body?.id);
      const data = validateData(req.body?.data, schema, { operation: "update", actor, now: now() });
      const reason = validateReason(req.body?.reason);
      const result = await callGateway("POST", req.params.kind, { operation: "update", id, data, actor, reason }, { fetchImpl, env });
      if (!result?.row) return res.status(404).json({ error: "Commercial data row not found; no update was made." });
      return res.json({ row: result.row });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete("/api/dynamic-data/:kind", requireAdmin, async (req, res) => {
    if (!KIND_SCHEMAS[req.params.kind]) return res.status(400).json({ error: "Unsupported commercial data kind." });
    try {
      const actor = trustedActor(req);
      const id = validateId(req.body?.id);
      const reason = validateReason(req.body?.reason);
      const result = await callGateway("POST", req.params.kind, { operation: "delete", id, data: {}, actor, reason }, { fetchImpl, env });
      if (!result?.row) return res.status(404).json({ error: "Commercial data row not found; no deletion was made." });
      return res.json({ row: result.row });
    } catch (error) {
      return sendError(res, error);
    }
  });
}

function validateData(value, schema, { operation, actor, now }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "Provide commercial data as an object.");
  const keys = Object.keys(value);
  if (!keys.length) throw httpError(400, "Provide at least one commercial data field.");
  for (const key of keys) {
    if (!schema.fields.has(key)) throw httpError(400, `Unsupported field: ${key}.`);
  }

  const data = { ...value };
  if (operation === "create") {
    for (const field of schema.required) if (data[field] === undefined || data[field] === null || data[field] === "") throw httpError(400, `Missing required field: ${field}.`);
    if (data.review_status === undefined) data.review_status = "draft";
    if (data.active === undefined) data.active = false;
  }
  if (operation === "update" && schema.fields.has("valid_from") && (data.valid_from !== undefined || data.effective_from !== undefined) && (data.valid_from === undefined || data.effective_from === undefined)) {
    throw httpError(400, "Update offer valid-from and effective dates together.");
  }
  if (operation === "update" && (data.effective_from !== undefined || data.valid_until !== undefined) && (data.effective_from === undefined || data.valid_until === undefined)) {
    throw httpError(400, "Update effective and expiry dates together.");
  }
  if (data.review_status !== undefined && !["draft", "approved", "blocked"].includes(data.review_status)) throw httpError(400, "Review status must be draft, approved, or blocked.");
  if (data.review_status === "approved") {
    data.reviewed_by = actor;
    data.verified_at = now.toISOString();
  }

  for (const field of Object.keys(schema.labels)) if (data[field] !== undefined && (!Number.isFinite(Number(data[field])) || Number(data[field]) < 0)) throw httpError(400, `${schema.labels[field]} must be a nonnegative number.`);
  if (data.currency !== undefined && !/^[A-Z]{3}$/.test(data.currency)) throw httpError(400, "Currency must be a three-letter uppercase code.");
  if (data.active !== undefined && typeof data.active !== "boolean") throw httpError(400, "Active must be true or false.");
  if (data.review_status !== undefined && !["draft", "approved", "blocked"].includes(data.review_status)) throw httpError(400, "Invalid review status.");
  if (data.effective_from !== undefined) validateTimestamp(data.effective_from, "Effective date");
  if (data.valid_until !== undefined) validateTimestamp(data.valid_until, "Expiry date");
  if (data.valid_from !== undefined) validateTimestamp(data.valid_from, "Offer valid-from date");
  if (data.delivery_date !== undefined && data.delivery_date !== null && !isDateOnly(data.delivery_date)) throw httpError(400, "Delivery date must be an ISO date.");
  if (data.effective_from && data.valid_until && Date.parse(data.valid_until) <= Date.parse(data.effective_from)) throw httpError(400, "Expiry date must be later than the effective date.");
  if (data.valid_from && data.effective_from && data.valid_from !== data.effective_from) throw httpError(400, "Offer valid-from and effective dates must match.");
  if (data.review_status === "approved" && data.valid_until && Date.parse(data.valid_until) > now.getTime() + 30 * 24 * 60 * 60 * 1000) throw httpError(400, "Approved offer validity cannot exceed 30 days from verification.");

  if (data.inclusions !== undefined && (!Array.isArray(data.inclusions) || data.inclusions.some((item) => typeof item !== "string"))) throw httpError(400, "Offer inclusions must be a list of text items.");
  if (data.eligibility !== undefined && (!data.eligibility || typeof data.eligibility !== "object" || Array.isArray(data.eligibility))) throw httpError(400, "Eligibility must be an object.");
  if (data.status !== undefined && !["offplan", "completed"].includes(data.status)) throw httpError(400, "Property status must be offplan or completed.");
  if (data.bedrooms !== undefined && data.bedrooms !== null && (!Number.isInteger(data.bedrooms) || data.bedrooms < 0 || data.bedrooms > 100)) throw httpError(400, "Bedrooms must be an integer from 0 to 100.");
  for (const field of ["first_sale", "pr_eligible", "available", "refundable"]) if (data[field] !== undefined && data[field] !== null && typeof data[field] !== "boolean") throw httpError(400, `${field} must be true, false, or null.`);
  if (data.item !== undefined && !["secretary", "address", "accounting", "audit", "tax"].includes(data.item)) throw httpError(400, "Unsupported renewal fee item.");

  const hasAmount = data.deposit_amount !== undefined && data.deposit_amount !== null;
  const hasPercent = data.deposit_percent !== undefined && data.deposit_percent !== null;
  if (schema.fields.has("deposit_amount") && operation === "create" && hasAmount === hasPercent) throw httpError(400, "Provide exactly one of deposit amount or deposit percentage.");
  if (schema.fields.has("deposit_amount") && operation === "update" && (data.deposit_amount !== undefined || data.deposit_percent !== undefined) && (data.deposit_amount === undefined || data.deposit_percent === undefined || hasAmount === hasPercent)) throw httpError(400, "To change a deposit, provide exactly one deposit value and clear the other with null.");
  if (data.deposit_percent !== undefined && data.deposit_percent !== null && (!Number.isFinite(Number(data.deposit_percent)) || Number(data.deposit_percent) <= 0 || Number(data.deposit_percent) > 100)) throw httpError(400, "Deposit percentage must be greater than 0 and no more than 100.");
  if (operation === "create" && data.review_status === "approved") {
    // Review identity and verification time are server controlled, never caller supplied.
    data.reviewed_by = actor;
    data.verified_at = now.toISOString();
  }
  return data;
}

async function callGateway(method, kind, body, { fetchImpl, env }) {
  const baseUrl = env.RAFA_API_URL || `${String(env.SUPABASE_URL || "").replace(/\/$/, "")}/functions/v1/rafa-agent-api`;
  const secret = env.RAFA_API_SECRET;
  if (!baseUrl || baseUrl === "/functions/v1/rafa-agent-api" || !secret) throw unavailableError("Dynamic commercial data gateway is not configured.");
  const adminView = method === "GET" ? "?view=admin" : "";
  const url = `${baseUrl.replace(/\/$/, "")}/dynamic-data/${encodeURIComponent(kind)}${adminView}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { "content-type": "application/json", "x-rafa-api-secret": secret },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw unavailableError("Dynamic commercial data service is unavailable.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(payload.code || payload.error_code || "");
    const message = String(payload.error || payload.message || "");
    if (MISSING_OBJECT_CODES.has(code) || /migration.{0,30}(missing|not applied)|schema cache.{0,30}(dynamic|refal_)/i.test(message)) throw unavailableError("Dynamic commercial data schema is not available because its migration is not applied.", "dynamic_data_migration_missing");
    if (code === "P0002" || code === "dynamic_data_row_not_found" || (response.status === 404 && /dynamic data row was not found|commercial data row not found/i.test(message))) throw httpError(404, "Commercial data row not found.");
    if (response.status === 400 || response.status === 422) throw httpError(400, message || "Commercial data request is invalid.");
    if (response.status === 401 || response.status === 403) throw httpError(503, "Dynamic commercial data service is unavailable.");
    throw unavailableError("Dynamic commercial data service is unavailable.");
  }
  return payload;
}

function trustedActor(req) {
  const actor = String(req.dashboardUser?.email || req.dashboardUser?.id || "").trim();
  if (!actor || actor.length > 200) throw httpError(403, "A verified dashboard administrator is required.");
  return actor;
}

function validateReason(value) {
  const reason = String(value || "").trim();
  if (!reason || reason.length > 500) throw httpError(400, "Provide an audit reason of 1 to 500 characters.");
  return reason;
}

function validateId(value) {
  const id = String(value || "");
  if (!UUID.test(id)) throw httpError(400, "Invalid commercial data row ID.");
  return id;
}

function validateTimestamp(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)) || !isDateOnly(value.slice(0, 10))) throw httpError(400, `${label} must be an ISO timestamp with timezone.`);
}

function isDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function unavailableError(message = "Dynamic commercial data is unavailable.", code = "dynamic_data_unavailable") {
  return httpError(503, message, code);
}

function httpError(status, message, code = "") {
  const error = new Error(message);
  error.status = status;
  error.publicCode = code;
  return error;
}

function sendError(res, error) {
  const status = error.status || 503;
  const message = status !== 503
    ? error.message
    : error.publicCode === "dynamic_data_migration_missing"
      ? "Dynamic commercial data is unavailable because its migration is not applied."
      : "Dynamic commercial data is currently unavailable.";
  return res.status(status).json({ error: message, ...(error.publicCode ? { code: error.publicCode } : {}) });
}

export const dynamicDataSchemas = KIND_SCHEMAS;
