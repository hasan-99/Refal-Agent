const KINDS = [
  { id: "offers", label: "Offers", description: "Promotions and formation packages" },
  { id: "renewals", label: "Renewal fees", description: "Annual company services" },
  { id: "properties", label: "Properties", description: "Approved property inventory" },
  { id: "reservations", label: "Reservation rules", description: "Property and project deposits" },
  { id: "governmentFees", label: "Government fees", description: "Third party fees" }
];

const SHAPES = {
  offers: [
    field("code", "Offer code", "text", { required: true }),
    field("title_en", "Title · English", "text", { required: true }),
    field("title_ar", "Title · Arabic", "text"),
    field("title_el", "Title · Greek", "text"),
    field("amount", "Amount", "number", { required: true, min: 0, step: "0.01" }),
    field("currency", "Currency", "text", { required: true, defaultValue: "EUR", maxLength: 3 }),
    field("vat_note", "VAT treatment", "text"),
    field("inclusions", "Included items · one per line", "lines"),
    field("valid_from", "Offer valid from", "datetime-local", { required: true }),
    field("effective_from", "Effective from", "datetime-local", { required: true })
  ],
  renewals: [
    field("item", "Service", "select", { required: true, options: ["secretary", "address", "accounting", "audit", "tax"] }),
    field("amount", "Amount", "number", { required: true, min: 0, step: "0.01" }),
    field("currency", "Currency", "text", { required: true, defaultValue: "EUR", maxLength: 3 }),
    field("period", "Billing period", "text", { required: true, defaultValue: "annual" }),
    field("notes_en", "Conditions · English", "textarea"),
    field("notes_ar", "Conditions · Arabic", "textarea"),
    field("notes_el", "Conditions · Greek", "textarea")
  ],
  properties: [
    field("reference", "Property reference", "text", { required: true }),
    field("city", "City", "text", { required: true }),
    field("type", "Property type", "text", { required: true }),
    field("status", "Construction status", "select", { required: true, options: ["offplan", "completed"] }),
    field("price", "Price", "number", { required: true, min: 0, step: "0.01" }),
    field("currency", "Currency", "text", { required: true, defaultValue: "EUR", maxLength: 3 }),
    field("vat_rate_note", "VAT treatment", "text"),
    field("bedrooms", "Bedrooms", "number", { min: 0, max: 100, step: "1", nullable: true }),
    field("first_sale", "First sale", "selectNullable", { options: ["true", "false"] }),
    field("pr_eligible", "Permanent residency eligibility", "selectNullable", { options: ["true", "false"] }),
    field("available", "Currently available", "checkbox", { defaultValue: false }),
    field("developer", "Developer", "text"),
    field("delivery_date", "Delivery date", "date", { nullable: true })
  ],
  reservations: [
    field("project_or_property_id", "Project or property reference", "text", { required: true }),
    field("deposit_mode", "Deposit type", "select", { required: true, options: ["amount", "percent"] }),
    field("deposit_value", "Deposit value", "number", { required: true, min: 0, step: "0.01" }),
    field("currency", "Currency", "text", { required: true, defaultValue: "EUR", maxLength: 3 }),
    field("refundable", "Refundable", "selectNullable", { options: ["true", "false"] }),
    field("conditions_en", "Conditions · English", "textarea"),
    field("conditions_ar", "Conditions · Arabic", "textarea"),
    field("conditions_el", "Conditions · Greek", "textarea")
  ],
  governmentFees: [
    field("fee_type", "Fee type", "text", { required: true }),
    field("amount", "Amount", "number", { required: true, min: 0, step: "0.01" }),
    field("currency", "Currency", "text", { required: true, defaultValue: "EUR", maxLength: 3 }),
    field("authority", "Authority", "text", { required: true })
  ]
};

const COMMON_FIELDS = [
  field("effective_from", "Effective from", "datetime-local", { required: true }),
  field("valid_until", "Expires at", "datetime-local", { required: true }),
  field("review_status", "Review status", "select", { required: true, defaultValue: "draft", options: ["draft", "approved", "blocked"] }),
  field("active", "Active", "checkbox", { defaultValue: false }),
  field("location", "Location code", "text", { defaultValue: "CY" }),
  field("eligibility", "Eligibility details · JSON object", "json", { defaultValue: "{}" }),
  field("source_note", "Source and verification note", "textarea", { required: true })
];

function field(name, label, type, options = {}) { return { name, label, type, ...options }; }

function buildPayload(kind, form) {
  const fields = fieldsFor(kind);
  const payload = {};
  for (const item of fields) {
    const value = form[item.name];
    if (item.name === "deposit_mode" || item.name === "deposit_value") continue;
    if (item.type === "datetime-local") payload[item.name] = value ? new Date(value).toISOString() : "";
    else if (item.type === "lines") payload[item.name] = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    else if (item.type === "json") payload[item.name] = JSON.parse(value || "{}");
    else if (item.type === "number") payload[item.name] = value === "" && item.nullable ? null : value === "" ? "" : Number(value);
    else if (item.type === "checkbox") payload[item.name] = Boolean(value);
    else if (item.type === "selectNullable") payload[item.name] = value === "" ? null : value === "true";
    else if (item.type === "text" || item.type === "textarea") payload[item.name] = String(value ?? "");
    else if (value !== "") payload[item.name] = value;
  }
  if (kind === "reservations") {
    const amountMode = form.deposit_mode === "amount";
    payload.deposit_amount = amountMode ? Number(form.deposit_value) : null;
    payload.deposit_percent = amountMode ? null : Number(form.deposit_value);
  }
  return payload;
}

function fieldsFor(kind) {
  const shapeFields = SHAPES[kind];
  if (!shapeFields) throw new Error(`Unknown commercial data kind: ${kind}`);
  return [...shapeFields, ...COMMON_FIELDS.filter((item) => !shapeFields.some((shape) => shape.name === item.name))];
}

export { buildPayload, COMMON_FIELDS, fieldsFor, KINDS, SHAPES };
