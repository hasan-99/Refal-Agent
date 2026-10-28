import { redactAuditEventFields } from "../src/sensitiveData.js";

const SAFE_LABEL = /^[a-z][a-z0-9_.:-]{0,119}$/iu;

function safeLabel(value) {
  const label = String(value ?? "").trim();
  return SAFE_LABEL.test(label) ? label : "unknown";
}

export function shapeLegacyAdminEvents(events, allowedEvents) {
  const allowed = allowedEvents instanceof Set ? allowedEvents : new Set();
  return (Array.isArray(events) ? events : []).filter((event) => allowed.has(event?.event)).slice(-100).reverse().map((event) => {
    const fields = Array.isArray(event?.fields) ? event.fields.slice(0, 20).map((field) => safeLabel(field)) : [];
    if (event?.event === "business_guidance_admin_updated" && event.fields && typeof event.fields === "object" && !Array.isArray(event.fields)) {
      const metadata = redactAuditEventFields(event.fields);
      const reason = typeof metadata.reasonCode === "string" ? safeLabel(metadata.reasonCode) : "unknown";
      const changed = Array.isArray(metadata.guidanceItemCodes) ? metadata.guidanceItemCodes.map(safeLabel) : [];
      fields.push(`reason: ${reason}`);
      if (changed.length) fields.push(`changed items: ${changed.join(", ")}`);
    }
    return {
      event: safeLabel(event?.event),
      at: typeof event?.at === "string" ? event.at : "",
      actor: String(event?.fields?.actor && event.fields.actor !== "[redacted]" ? event.fields.actor : event?.actor || event?.reviewer || "admin").slice(0, 160),
      action: safeLabel(event?.action || event?.event),
      fields
    };
  });
}

export function shapeDatabaseAuditEvents(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: safeLabel(row?.id),
    event: safeLabel(row?.event),
    actorType: safeLabel(row?.actor_type),
    source: safeLabel(row?.source),
    at: typeof row?.created_at === "string" ? row.created_at : "",
    details: redactAuditEventFields(row?.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details : {})
  }));
}
