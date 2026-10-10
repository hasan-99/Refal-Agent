import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Clock3, Database, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import "./dynamic-data.css";

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
    field("effective_from", "Effective from", "datetime-local", { required: true }),
    field("valid_until", "Expires at", "datetime-local", { required: true })
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
  return [...SHAPES[kind], ...COMMON_FIELDS.filter((item) => !(kind === "offers" && item.name === "effective_from"))];
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function toLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function rowTitle(kind, row) {
  if (kind === "offers") return `${row.title_en || row.code} · ${row.code}`;
  if (kind === "renewals") return row.item;
  if (kind === "properties") return `${row.reference} · ${row.city}`;
  if (kind === "reservations") return row.project_or_property_id;
  return row.fee_type;
}

function rowValue(kind, row) {
  const amount = kind === "properties" ? row.price : kind === "reservations" ? row.deposit_amount ?? row.deposit_percent : row.amount;
  const currency = row.currency || "";
  const suffix = kind === "reservations" && row.deposit_percent !== null && row.deposit_percent !== undefined ? "% deposit" : ` ${currency}`;
  return amount === null || amount === undefined ? "Value not set" : `${amount}${suffix}`;
}

function rowDates(row) {
  const from = row.effective_from ? new Date(row.effective_from).toLocaleDateString() : "Date not set";
  const until = row.valid_until ? new Date(row.valid_until).toLocaleDateString() : "No expiry";
  return `${from} → ${until}`;
}

function initialForm(kind, row = null) {
  const fields = fieldsFor(kind);
  const values = {};
  for (const item of fields) {
    let value = row?.[item.name];
    if (item.name === "deposit_mode") value = row?.deposit_percent != null ? "percent" : "amount";
    if (item.name === "deposit_value") value = row?.deposit_percent ?? row?.deposit_amount;
    if (item.type === "datetime-local") value = toLocalDateTime(value);
    else if (item.type === "lines") value = Array.isArray(value) ? value.join("\n") : "";
    else if (item.type === "json") value = JSON.stringify(value ?? {}, null, 2);
    else if (item.type === "selectNullable") value = value === null || value === undefined ? "" : String(value);
    else if (item.type === "checkbox") value = value === undefined ? Boolean(item.defaultValue) : Boolean(value);
    else if (value === undefined || value === null) value = item.defaultValue ?? "";
    values[item.name] = value;
  }
  return values;
}

function buildPayload(kind, form) {
  const fields = fieldsFor(kind);
  const payload = {};
  for (const item of fields) {
    const value = form[item.name];
    if (item.name === "deposit_mode" || item.name === "deposit_value") continue;
    if (item.type === "datetime-local") payload[item.name] = value ? new Date(value).toISOString() : "";
    else if (item.type === "lines") payload[item.name] = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    else if (item.type === "json") payload[item.name] = JSON.parse(value || "{}");
    else if (item.type === "number") payload[item.name] = value === "" && item.nullable ? null : value === "" ? "" : Number(value);
    else if (item.type === "checkbox") payload[item.name] = Boolean(value);
    else if (item.type === "selectNullable") payload[item.name] = value === "" ? null : value === "true";
    else if (item.type !== "checkbox" && value !== "") payload[item.name] = value;
  }
  if (kind === "reservations") {
    const amountMode = form.deposit_mode === "amount";
    payload.deposit_amount = amountMode ? Number(form.deposit_value) : null;
    payload.deposit_percent = amountMode ? null : Number(form.deposit_value);
  }
  return payload;
}

export default function DynamicData({ isAdmin }) {
  const [kind, setKind] = useState("offers");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(() => initialForm("offers"));
  const [reason, setReason] = useState("");
  const currentKind = useMemo(() => KINDS.find((item) => item.id === kind), [kind]);

  const load = useCallback(async ({ preserveNotice = false } = {}) => {
    setLoading(true);
    setError("");
    if (!preserveNotice) setNotice("");
    try {
      const result = await request(`/api/dynamic-data/${encodeURIComponent(kind)}`);
      setRows(Array.isArray(result.rows) ? result.rows : []);
      setMigrationMissing(false);
    } catch (cause) {
      setRows([]);
      setMigrationMissing(cause.code === "dynamic_data_migration_missing");
      setError(cause.message || "Could not load commercial data.");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { void load(); }, [load]);

  function changeKind(nextKind) {
    setKind(nextKind);
    setEditing(null);
    setForm(initialForm(nextKind));
    setReason("");
  }

  function startCreate() {
    setEditing(null);
    setForm(initialForm(kind));
    setReason("");
    setError("");
    setNotice("");
  }

  function startEdit(row) {
    setEditing(row);
    setForm(initialForm(kind, row));
    setReason("");
    setError("");
    setNotice("");
  }

  function setValue(name, value) { setForm((current) => ({ ...current, [name]: value })); }

  async function save(event) {
    event.preventDefault();
    if (!isAdmin || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = buildPayload(kind, form);
      const body = editing
        ? { id: editing.id, data, reason: reason.trim() }
        : { data, reason: reason.trim() };
      await request(`/api/dynamic-data/${encodeURIComponent(kind)}`, {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(body)
      });
      setEditing(null);
      setForm(initialForm(kind));
      setReason("");
      setNotice(editing ? "Commercial record updated and audit logged." : "Commercial record created and audit logged.");
      await load({ preserveNotice: true });
    } catch (cause) {
      setMigrationMissing(cause.code === "dynamic_data_migration_missing");
      setError(cause.message || "Could not save this commercial record.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(row) {
    if (!isAdmin || saving) return;
    if (!window.confirm(`Delete ${rowTitle(kind, row)}? This removes the commercial record and writes an audit event.`)) return;
    const why = window.prompt(`Why are you deleting ${rowTitle(kind, row)}? This reason is written to the audit record.`);
    if (!why?.trim()) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await request(`/api/dynamic-data/${encodeURIComponent(kind)}`, { method: "DELETE", body: JSON.stringify({ id: row.id, reason: why.trim() }) });
      if (editing?.id === row.id) { setEditing(null); setForm(initialForm(kind)); }
      setNotice("Commercial record deleted and audit logged.");
      await load({ preserveNotice: true });
    } catch (cause) {
      setMigrationMissing(cause.code === "dynamic_data_migration_missing");
      setError(cause.message || "Could not delete this commercial record.");
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) return <section className="dynamic-page"><div className="dynamic-alert error"><AlertTriangle size={18} /> Administrator access is required to manage commercial data.</div></section>;

  return (
    <section className="dynamic-page">
      <header className="dynamic-hero">
        <div>
          <span className="dynamic-kicker"><Database size={14} /> LIVE COMMERCIAL RECORDS</span>
          <h2>Manage approved business data</h2>
          <p>Keep offers, fees, property availability, and reservation terms current. Changes are recorded with your account and the reason you provide.</p>
        </div>
        <button className="primary dynamic-refresh" type="button" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={15} /> Refresh</button>
      </header>

      {migrationMissing && <div className="dynamic-alert migration"><AlertTriangle size={18} /><div><strong>Commercial data is not available yet</strong><p>The required database migration has not been applied. No records were loaded or changed.</p></div></div>}
      {error && !migrationMissing && <div className="dynamic-alert error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
      {notice && <div className="dynamic-alert success" role="status"><Check size={17} /><span>{notice}</span></div>}

      <div className="dynamic-tabs" role="tablist" aria-label="Commercial data types">
        {KINDS.map((item) => <button key={item.id} role="tab" aria-selected={kind === item.id} className={kind === item.id ? "selected" : ""} onClick={() => changeKind(item.id)} type="button"><strong>{item.label}</strong><small>{item.description}</small></button>)}
      </div>

      <div className="dynamic-workspace">
        <section className="dynamic-records" aria-label={`${currentKind.label} records`}>
          <div className="dynamic-section-head"><div><span className="dynamic-kicker">{currentKind.label.toUpperCase()}</span><h3>{rows.length} record{rows.length === 1 ? "" : "s"}</h3></div><button type="button" className="primary" onClick={startCreate} disabled={saving}><Plus size={15} /> Add record</button></div>
          {loading ? <div className="dynamic-empty"><Clock3 size={18} /> Loading records…</div>
            : rows.length === 0 ? <div className="dynamic-empty"><Database size={19} /><strong>No records found</strong><span>Add an approved source record when you have verified information.</span></div>
              : <div className="dynamic-record-list">{rows.map((row) => <article className={`dynamic-record ${row.review_status || "draft"}`} key={row.id}>
                <div className="dynamic-record-main"><div><strong>{rowTitle(kind, row)}</strong><small>{rowDates(row)}</small></div><span className={`dynamic-status ${row.review_status || "draft"}`}>{row.review_status || "draft"}{row.active ? " · active" : " · inactive"}</span></div>
                <div className="dynamic-record-meta"><strong>{rowValue(kind, row)}</strong>{kind === "properties" && <span>{row.bedrooms ?? "Bedrooms not set"} · {row.available ? "Available" : "Unavailable"}</span>}{kind === "renewals" && <span>{row.period}</span>}{kind === "governmentFees" && <span>{row.authority}</span>}{kind === "reservations" && <span>{row.refundable == null ? "Refundability not stated" : row.refundable ? "Refundable" : "Non-refundable"}</span>}</div>
                <div className="dynamic-record-actions"><button type="button" className="ghost" onClick={() => startEdit(row)} disabled={saving}><Pencil size={14} /> Edit</button><button type="button" className="danger-quiet" onClick={() => void remove(row)} disabled={saving}><Trash2 size={14} /> Delete</button></div>
              </article>)}</div>}
        </section>

        <section className="dynamic-editor" aria-label={editing ? "Edit commercial record" : "Create commercial record"}>
          <div className="dynamic-section-head"><div><span className="dynamic-kicker">{editing ? "EDIT RECORD" : "NEW RECORD"}</span><h3>{editing ? rowTitle(kind, editing) : `Add ${currentKind.label.toLowerCase()}`}</h3></div>{editing && <button className="icon-button" type="button" aria-label="Cancel editing" onClick={startCreate}><X size={16} /></button>}</div>
          <form onSubmit={save}>
            <div className="dynamic-form-grid">{fieldsFor(kind).map((item) => <FormField key={item.name} item={item} value={form[item.name]} setValue={setValue} kind={kind} />)}</div>
            <label className="dynamic-field dynamic-reason"><span>Reason for this change <b aria-hidden="true">*</b></span><textarea required maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example, verified against the latest owner-approved price list" /></label>
            {editing && <p className="dynamic-review-note">Approving this record stamps your signed-in account and the current verification time. The database records the previous and new values with this reason.</p>}
            <div className="dynamic-form-actions"><button type="submit" className="primary" disabled={saving}><Save size={15} /> {saving ? "Saving…" : editing ? "Save changes" : "Create record"}</button>{editing && <button type="button" className="ghost" onClick={startCreate} disabled={saving}>Cancel</button>}</div>
          </form>
        </section>
      </div>
    </section>
  );
}

function FormField({ item, value, setValue, kind }) {
  const id = `commercial-${kind}-${item.name}`;
  if (item.type === "checkbox") return <label className="dynamic-field dynamic-check" htmlFor={id}><input id={id} type="checkbox" checked={Boolean(value)} onChange={(event) => setValue(item.name, event.target.checked)} /><span>{item.label}</span></label>;
  const common = {
    id,
    name: item.name,
    value: value ?? "",
    required: item.required,
    min: item.min,
    max: item.max,
    step: item.step,
    maxLength: item.maxLength,
    onChange: (event) => setValue(item.name, item.name === "currency" ? event.target.value.toUpperCase() : event.target.value)
  };
  let control;
  if (item.type === "select" || item.type === "selectNullable") {
    control = <select {...common}><option value="">{item.type === "selectNullable" ? "Not specified" : "Choose one"}</option>{item.options.map((option) => <option value={option} key={option}>{option}</option>)}</select>;
  } else if (item.type === "textarea" || item.type === "lines" || item.type === "json") {
    control = <textarea {...common} rows={item.type === "json" ? 3 : 2} placeholder={item.type === "json" ? '{ "category": "..." }' : item.type === "lines" ? "Company registration\nRegistered office" : ""} />;
  } else {
    control = <input {...common} type={item.type} />;
  }
  const full = item.type === "textarea" || item.type === "lines" || item.type === "json" || ["effective_from", "valid_until", "valid_from", "source_note"].includes(item.name);
  return <label className={`dynamic-field ${full ? "full" : ""}`} htmlFor={id}><span>{item.label}{item.required && <b aria-hidden="true"> *</b>}</span>{control}</label>;
}

export { buildPayload, initialForm, KINDS, SHAPES };
