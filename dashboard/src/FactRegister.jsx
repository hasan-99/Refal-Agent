import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, History, RefreshCcw, ShieldBan, ShieldCheck } from "lucide-react";
import "./fact-register.css";

// W3.9.7 — the fact register admin surface.
//
// This page exists so an operator can see WHY REFAL will or will not state a
// number, and fix it in one click instead of a release. The effective status is
// the clock-aware one computed by src/factRegister.js, not the stored intent, so
// a row that quietly passed its review date shows as expired here exactly as
// REFAL already treats it.
//
// The register migration has not been applied in every environment yet. When
// the table is absent the API answers 503 with `migrationApplied: false`, and
// this page says so loudly. An empty table would read as "nothing needs
// review", which is the one wrong answer.

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.payload = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

const STATUS_ICONS = { approved: CheckCircle2, expired: Clock3, blocked: ShieldBan, pending: Clock3 };

const STATUS_ORDER = ["approved", "expired", "blocked", "pending"];

function daysLeftLabel(daysLeft) {
  if (!Number.isFinite(daysLeft)) return "No review date";
  if (daysLeft < 0) return `${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} overdue`;
  if (daysLeft === 0) return "Due today";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}

function daysLeftTone(daysLeft) {
  if (!Number.isFinite(daysLeft)) return "none";
  if (daysLeft < 0) return "overdue";
  if (daysLeft <= 7) return "soon";
  return "ok";
}

function timestampLabel(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Time unavailable";
}

function auditChange(entry) {
  const keys = [...new Set([...Object.keys(entry.previous || {}), ...Object.keys(entry.next || {})])];
  const changed = keys.filter((key) => String(entry.previous?.[key] ?? "") !== String(entry.next?.[key] ?? ""));
  if (!changed.length) return "No field changes recorded.";
  return changed.map((key) => `${key.replaceAll("_", " ")}: ${entry.previous?.[key] ?? "—"} → ${entry.next?.[key] ?? "—"}`).join(" · ");
}

export default function FactRegister({ isAdmin }) {
  const [register, setRegister] = useState(null);
  const [due, setDue] = useState(null);
  const [migration, setMigration] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [topicFilter, setTopicFilter] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [dueDays, setDueDays] = useState(7);
  const [expandedId, setExpandedId] = useState("");
  const [auditByFact, setAuditByFact] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyFactId, setBusyFactId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const query = new URLSearchParams();
      if (statusFilter && statusFilter !== "all") query.set("status", statusFilter);
      if (topicFilter) query.set("topic", topicFilter);
      const [facts, soon] = await Promise.all([
        request(`/api/facts${query.toString() ? `?${query}` : ""}`),
        request(`/api/facts/due?days=${encodeURIComponent(dueDays)}`)
      ]);
      setRegister(facts);
      setDue(soon);
      setMigration(null);
      setAuditByFact({});
    } catch (cause) {
      // The unapplied migration is a distinct, expected state, not a failure to
      // retry. Keep it out of the red error strip and off the empty table.
      if (cause.payload?.migrationApplied === false) {
        setMigration(cause.payload);
        setRegister(null);
        setDue(null);
      } else {
        setError(cause.message || "Could not load the fact register.");
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter, topicFilter, dueDays]);

  useEffect(() => { void load(); }, [load]);

  const dueIds = useMemo(() => new Set((due?.facts || []).map((fact) => fact.id)), [due]);
  const facts = useMemo(() => {
    const rows = register?.facts || [];
    return dueOnly ? rows.filter((fact) => dueIds.has(fact.id)) : rows;
  }, [register, dueOnly, dueIds]);

  const explanations = register?.statusExplanations || {};
  const counts = register?.counts || null;

  async function reapprove(fact) {
    if (!isAdmin || busyFactId) return;
    const reviewer = (window.prompt(`Re-approve ${fact.id}. Who is confirming this claim? The name is written to the audit trail:`) || "").trim();
    if (!reviewer) return;
    const reason = (window.prompt("Optional reason for the audit record (for example, the source you checked):") || "").trim();
    setBusyFactId(fact.id); setError(""); setNotice("");
    try {
      const result = await request(`/api/facts/${encodeURIComponent(fact.id)}/reapprove`, { method: "POST", body: JSON.stringify({ reviewer, reason }) });
      const nextReview = result.result?.expiry_or_review_at;
      setNotice(`${fact.id} re-approved by ${reviewer}${nextReview ? `. Next review ${nextReview}.` : "."} The date was re-set from today, not extended from the old one.`);
      await load();
    } catch (cause) {
      if (cause.payload?.migrationApplied === false) setMigration(cause.payload);
      else setError(cause.message || `Could not re-approve ${fact.id}.`);
    } finally {
      setBusyFactId("");
    }
  }

  async function toggleAudit(fact) {
    if (expandedId === fact.id) { setExpandedId(""); return; }
    setExpandedId(fact.id);
    if (auditByFact[fact.id]) return;
    try {
      const audit = await request(`/api/facts/${encodeURIComponent(fact.id)}/audit`);
      setAuditByFact((current) => ({ ...current, [fact.id]: { entries: audit.entries || [] } }));
    } catch (cause) {
      setAuditByFact((current) => ({ ...current, [fact.id]: { entries: [], error: cause.message || "Could not load the audit trail." } }));
    }
  }

  return <div className="page-stack facts-page">
    <section className="facts-hero">
      <div>
        <span className="facts-kicker"><ShieldCheck size={14} /> RULE 2 · FACT REGISTER</span>
        <h2>Facts REFAL may state</h2>
        <p>Every number REFAL asserts carries provenance and a review date. A fact past its date stops being stated on its own, with no code change. Re-approving re-dates it from today.</p>
      </div>
      <button className="ghost facts-refresh" type="button" onClick={() => void load()} disabled={loading}><RefreshCcw size={15} /> Refresh</button>
    </section>

    {migration && <div className="facts-migration" role="status">
      <AlertTriangle size={18} />
      <div>
        <strong>The fact register migration has not been applied yet.</strong>
        <p>{migration.error || "There is no register to read, so this page cannot tell you which facts need review. This is not the same as “no facts need review”."}</p>
        {migration.migration && <code>{migration.migration}</code>}
      </div>
    </div>}

    {error && <div className="facts-alert" role="alert">{error}</div>}
    {notice && <div className="facts-notice" role="status">{notice}</div>}

    {!migration && <>
      <section className="facts-banner" aria-label="Review workload">
        <article className={counts?.dueWithin7 ? "facts-stat soon" : "facts-stat"}>
          <span>DUE IN {due?.days ?? 7} DAYS</span>
          <strong>{counts ? counts.dueWithin7 : "—"}</strong>
          <small>Still stated, but the review date is close.</small>
        </article>
        <article className={counts?.expired ? "facts-stat overdue" : "facts-stat"}>
          <span>ALREADY EXPIRED</span>
          <strong>{counts ? counts.expired : "—"}</strong>
          <small>REFAL has already stopped stating these.</small>
        </article>
        <article className="facts-stat">
          <span>BLOCKED</span>
          <strong>{counts ? counts.blocked : "—"}</strong>
          <small>Removed from retrieval entirely.</small>
        </article>
        <article className="facts-stat">
          <span>IN THE REGISTER</span>
          <strong>{counts ? counts.total : "—"}</strong>
          <small>{counts ? `${counts.highRisk} marked high risk.` : "Facts under Rule 2."}</small>
        </article>
      </section>

      <section className="facts-legend" aria-label="What each status means">
        {STATUS_ORDER.filter((status) => explanations[status]).map((status) => {
          const Icon = STATUS_ICONS[status] || Clock3;
          return <div className={`facts-legend-item ${status}`} key={status}>
            <span className={`facts-pill ${status}`}><Icon size={12} /> {status}</span>
            <small>{explanations[status]}</small>
          </div>;
        })}
      </section>

      <section className="facts-controls" aria-label="Filters">
        <label>Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            {STATUS_ORDER.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label>Topic
          <select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)}>
            <option value="">All topics</option>
            {(register?.topics || []).map((topic) => <option key={topic} value={topic}>{topic}</option>)}
          </select>
        </label>
        <label>Review horizon
          <input type="number" min={0} max={365} value={dueDays} onChange={(event) => setDueDays(Math.max(0, Math.min(365, Number(event.target.value) || 0)))} />
        </label>
        <label className="facts-toggle">
          <input type="checkbox" checked={dueOnly} onChange={(event) => setDueOnly(event.target.checked)} />
          Only facts due within {dueDays} days{due ? ` (${due.counts.total})` : ""}
        </label>
      </section>

      <section className="facts-table-wrap panel" aria-label="Fact register">
        {loading && !register ? <p className="facts-empty">Loading the fact register…</p> : facts.length === 0 ? <p className="facts-empty">No fact in the register matches these filters. The register itself holds {counts?.total ?? 0} facts.</p> : <table className="facts-table">
          <thead>
            <tr>
              <th>Fact</th><th>Claim</th><th>Topics</th><th>Jurisdiction</th><th>Status</th>
              <th>Verified</th><th>Review date</th><th>Days left</th><th>Risk</th><th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => {
              const Icon = STATUS_ICONS[fact.effectiveStatus] || Clock3;
              const audit = auditByFact[fact.id];
              return <React.Fragment key={fact.id}>
                <tr className={`facts-row ${fact.effectiveStatus}`}>
                  <td className="facts-id">{fact.id}</td>
                  <td className="facts-claim" title={fact.claimText}>{fact.claimText}</td>
                  <td className="facts-topics">{fact.topics.length ? fact.topics.map((topic) => <span className="facts-chip" key={topic}>{topic}</span>) : <small>—</small>}</td>
                  <td>{fact.jurisdiction || "—"}</td>
                  <td><span className={`facts-pill ${fact.effectiveStatus}`} title={fact.statusExplanation}><Icon size={12} /> {fact.effectiveStatus}</span>{fact.status !== fact.effectiveStatus && <small className="facts-stored">stored: {fact.status}</small>}</td>
                  <td>{fact.verifiedAt || "—"}</td>
                  <td>{fact.expiryOrReviewAt || "—"}</td>
                  <td><span className={`facts-days ${daysLeftTone(fact.daysLeft)}`}>{daysLeftLabel(fact.daysLeft)}</span></td>
                  <td>{fact.highRisk ? <span className="facts-risk">High risk</span> : <small>—</small>}</td>
                  <td className="facts-actions">
                    <button className="primary" type="button" disabled={!isAdmin || busyFactId === fact.id} onClick={() => void reapprove(fact)} title={isAdmin ? "Re-date this fact from today and record who confirmed it" : "Admins can re-approve facts"}>
                      <CheckCircle2 size={14} /> {busyFactId === fact.id ? "Working…" : "Re-approve"}
                    </button>
                    <button className="ghost" type="button" onClick={() => void toggleAudit(fact)} aria-expanded={expandedId === fact.id}>
                      <History size={14} /> Audit
                    </button>
                  </td>
                </tr>
                {expandedId === fact.id && <tr className="facts-audit-row">
                  <td colSpan={10}>
                    <div className="facts-audit">
                      <div className="facts-audit-head"><strong>Who changed {fact.id}</strong><small>Append only · newest first · feeds the M12 audit view</small></div>
                      {!audit ? <p className="facts-empty">Loading the audit trail…</p>
                        : audit.error ? <p className="facts-alert">{audit.error}</p>
                        : audit.entries.length === 0 ? <p className="facts-empty">No recorded change yet. The seed itself is the only provenance so far: reviewer {fact.reviewer || "unknown"}, verified {fact.verifiedAt || "unknown"}.</p>
                        : <ul className="facts-audit-list">{audit.entries.map((entry) => <li key={entry.id}>
                          <span className={`facts-action ${entry.action}`}>{entry.action}</span>
                          <strong>{entry.actor}</strong>
                          <small>{timestampLabel(entry.createdAt)}</small>
                          <p>{auditChange(entry)}{entry.reason ? ` — ${entry.reason}` : ""}</p>
                        </li>)}</ul>}
                    </div>
                  </td>
                </tr>}
              </React.Fragment>;
            })}
          </tbody>
        </table>}
      </section>
    </>}
  </div>;
}
