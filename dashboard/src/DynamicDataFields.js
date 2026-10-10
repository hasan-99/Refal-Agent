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
function fieldsFor(kind) {
  const shapeFields = SHAPES[kind];
  if (!shapeFields) throw new Error(`Unknown commercial data kind: ${kind}`);
  return [...shapeFields, ...COMMON_FIELDS.filter((item) => !shapeFields.some((shape) => shape.name === item.name))];
}

export { COMMON_FIELDS, fieldsFor, KINDS, SHAPES };
