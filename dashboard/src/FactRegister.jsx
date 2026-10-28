import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, History, MoreHorizontal, Pencil, Plus, RefreshCcw, Save, ShieldBan, ShieldCheck, X } from "lucide-react";
import "./fact-register.css";
import { summarizeManualEvidenceFacts } from "../factRegisterProvenance.js";

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

export default function FactRegister({ isAdmin, onAddKnowledge }) {
  const [register, setRegister] = useState(null);
  const [due, setDue] = useState(null);
  const [migration, setMigration] = useState(null);
  const dueDays = 7;
  const [expandedId, setExpandedId] = useState("");
  const [actionMenuFactId, setActionMenuFactId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState(null);
  const [approvalFactId, setApprovalFactId] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [auditByFact, setAuditByFact] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyFactId, setBusyFactId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showManualEvidenceOnly, setShowManualEvidenceOnly] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [facts, soon] = await Promise.all([
        request("/api/facts"),
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
  }, []);

  useEffect(() => { void load(); }, [load]);

  const facts = register?.facts || [];
  const manualEvidence = summarizeManualEvidenceFacts(facts);
  const visibleFacts = showManualEvidenceOnly ? manualEvidence.facts : facts;

  const explanations = {
    approved: "REFAL states it with its evidence.",
    expired: "Not currently confirmed; offers a specialist.",
    blocked: "REFAL cannot retrieve it.",
    pending: "Authored, but not in force; REFAL does not state it yet.",
  };
  const counts = register?.counts || null;

  function beginApproval(fact) {
    setExpandedId(fact.id);
    setEditingId(""); setEditDraft(null);
    setApprovalFactId(fact.id); setApprovalReason("");
    setError(""); setNotice("");
  }

  async function reapprove(fact, reason) {
    if (!fact || !isAdmin || busyFactId) return;
    setBusyFactId(fact.id); setError(""); setNotice("");
    try {
      const result = await request(`/api/facts/${encodeURIComponent(fact.id)}/reapprove`, { method: "POST", body: JSON.stringify({ reason }) });
      const reviewer = result.reviewer || "the signed-in administrator";
      const nextReview = result.result?.expiry_or_review_at;
      const outcome = fact.status === "pending"
        ? "approved"
        : fact.effectiveStatus === "expired"
          ? "re-approved"
          : fact.status === "blocked"
            ? "re-enabled"
            : "review renewed";
      setNotice(`${fact.id} ${outcome} by ${reviewer}${nextReview ? `. Next review ${nextReview}.` : "."} The date was re-set from today, not extended from the old one.`);
      setApprovalFactId(""); setApprovalReason(""); setExpandedId("");
      await load();
    } catch (cause) {
      if (cause.payload?.migrationApplied === false) setMigration(cause.payload);
      else setError(cause.message || `Could not re-approve ${fact.id}.`);
    } finally {
      setBusyFactId("");
    }
  }

  function editFact(fact) {
    setExpandedId(fact.id);
    setEditingId(fact.id);
    setApprovalFactId(""); setApprovalReason("");
    setEditDraft({
      sourceDocument: fact.sourceDocument,
      sourceRef: fact.sourceRef,
      notes: fact.notes,
      cadenceDays: String(fact.reviewCadenceDays || 90),
      approvedLanguages: [...fact.approvedLanguages],
      reason: ""
    });
    setError(""); setNotice("");
  }

  async function saveFactEdit(event, fact) {
    event.preventDefault();
    if (!isAdmin || !editDraft || busyFactId) return;
    setBusyFactId(fact.id); setError(""); setNotice("");
    try {
      const result = await request(`/api/facts/${encodeURIComponent(fact.id)}/review`, {
        method: "POST",
        body: JSON.stringify({ ...editDraft, cadenceDays: Number(editDraft.cadenceDays) })
      });
      setNotice(result.result?.evidence_changed
        ? `${fact.id} evidence saved. Its status is now pending review because the source changed.`
        : `${fact.id} review details saved with an audit record.`);
      setEditingId(""); setEditDraft(null); setExpandedId("");
      await load();
    } catch (cause) {
      if (cause.payload?.migrationApplied === false) setMigration(cause.payload);
      else setError(cause.message || `Could not save ${fact.id}.`);
    } finally {
      setBusyFactId("");
    }
  }

  function updateEdit(patch) {
    setEditDraft((current) => current ? { ...current, ...patch } : current);
  }

  async function toggleAudit(fact) {
    if (expandedId === fact.id) { setExpandedId(""); return; }
    setExpandedId(fact.id);
    setApprovalFactId(""); setApprovalReason("");
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
        <span className="facts-kicker"><ShieldCheck size={14} /> KNOWLEDGE GOVERNANCE · RULE 2</span>
        <h2>Fact &amp; evidence register</h2>
        <p>Review the claim, its evidence, and when it needs checking again. Only approved, current facts may support customer answers. This register follows REFAL’s curated fact catalogue; add new company guidance through reviewed knowledge, and keep new high risk or numeric claims in the catalogue workflow.</p>
      </div>
      <div className="facts-hero-actions">
        {isAdmin && onAddKnowledge && <button className="primary" type="button" onClick={onAddKnowledge}><Plus size={15} /> Add company knowledge</button>}
        <button className="ghost facts-refresh" type="button" onClick={() => void load()} disabled={loading}><RefreshCcw size={15} /> Refresh</button>
      </div>
    </section>

    {migration && <div className="facts-migration" role="status">
      <AlertTriangle size={18} />
      <div>
        <strong>The fact register migration has not been applied yet.</strong>
        <p>{migration.error || "There is no register to read, so this page cannot tell you which facts need review. This is not the same as “no facts need review”."}</p>
        {migration.migration && <code>{migration.migration}</code>}
        {migration.reviewEditorMigration && <code>{migration.reviewEditorMigration}</code>}
      </div>
    </div>}

    {error && <div className="facts-alert" role="alert">{error}</div>}
    {notice && <div className="facts-notice" role="status">{notice}</div>}
    {manualEvidence.facts.length > 0 && <div className={`facts-provenance-alert${manualEvidence.approved > 0 ? " has-approved" : " is-pending"}`} role={manualEvidence.approved > 0 ? "alert" : "status"}>
      <AlertTriangle size={18} />
      <div className="facts-provenance-copy"><strong>{manualEvidence.approved > 0 ? `${manualEvidence.approved} approved fact${manualEvidence.approved === 1 ? "" : "s"} still cite the owner source report.` : manualEvidence.pending > 0 ? `${manualEvidence.pending} pending fact${manualEvidence.pending === 1 ? "" : "s"} still cite the owner source report.` : `${manualEvidence.facts.length} fact record${manualEvidence.facts.length === 1 ? "" : "s"} still cite the owner source report and need evidence review.`}</strong><p>The source report is reference material, not approval evidence. Replace it with a current approved source and exact citation before an administrator reviews a fact for customer use.</p></div>
      <button className="ghost facts-provenance-toggle" type="button" aria-pressed={showManualEvidenceOnly} onClick={() => setShowManualEvidenceOnly((value) => !value)}>{showManualEvidenceOnly ? "Show all facts" : `Review ${manualEvidence.facts.length} facts`}</button>
    </div>}

    {!migration && <>
      <section className="facts-banner" aria-label="Review workload">
        <article className="facts-stat pending">
          <span>PENDING REVIEW</span>
          <strong>{counts ? counts.pending : "—"}</strong>
          <small>Not available for customer answers.</small>
        </article>
        <article className="facts-stat approved">
          <span>CURRENT &amp; USABLE</span>
          <strong>{counts ? counts.approved : "—"}</strong>
          <small>May be used while evidence stays current.</small>
        </article>
        <article className={counts?.expired ? "facts-stat overdue" : "facts-stat"}>
          <span>EXPIRED</span>
          <strong>{counts ? counts.expired : "—"}</strong>
          <small>Stopped until reviewed again.</small>
        </article>
        <article className={counts?.dueWithin7 ? "facts-stat soon" : "facts-stat"}>
          <span>DUE IN {due?.days ?? 7} DAYS</span>
          <strong>{counts ? counts.dueWithin7 : "—"}</strong>
          <small>{counts ? `${counts.total} total · ${counts.highRisk} high risk.` : "Review schedule."}</small>
        </article>
      </section>

      <section className="facts-legend" aria-label="What each status means">
        {STATUS_ORDER.filter((status) => explanations[status]).map((status) => {
          const Icon = STATUS_ICONS[status] || Clock3;
          return <div className={`facts-legend-item ${status}`} key={status}>
            <span className={`facts-pill ${status}`} aria-label={status} title={status === "approved" ? "Approved and current" : status}><Icon size={12} aria-hidden="true" />{status !== "approved" && <span>{status}</span>}</span>
            <small>{explanations[status]}</small>
          </div>;
        })}
      </section>

      <section className="facts-table-wrap panel" aria-label="Fact register">
        {loading && !register ? <p className="facts-empty">Loading the fact register…</p> : visibleFacts.length === 0 ? <p className="facts-empty">{showManualEvidenceOnly ? "No fact cites the owner source report." : `No fact in the register matches these filters. The register itself holds ${counts?.total ?? 0} facts.`}</p> : <table className="facts-table">
          <thead>
            <tr>
              <th>Fact</th><th>Claim</th><th>Evidence</th><th>Scope</th><th>Status</th>
              <th>Verified</th><th>Review date</th><th>Days left</th><th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {visibleFacts.map((fact) => {
              const Icon = STATUS_ICONS[fact.effectiveStatus] || Clock3;
              const audit = auditByFact[fact.id];
              const actionLabel = fact.status === "pending"
                ? "Approve"
                : fact.effectiveStatus === "expired"
                  ? "Re-approve"
                  : fact.status === "blocked"
                    ? "Re-enable"
                    : fact.effectiveStatus === "approved"
                      ? "Approved"
                      : "Approve";
              const actionTitle = fact.status === "pending"
                ? "Approve this pending fact and start its review period"
                : fact.effectiveStatus === "expired"
                  ? "Re-approve this expired fact and reset its review date from today"
                  : fact.status === "blocked"
                    ? "Re-enable this blocked fact and reset its review date from today"
                    : fact.effectiveStatus === "approved"
                      ? "This fact is already approved"
                      : "Approve this fact and start its review period";
              return <React.Fragment key={fact.id}>
                <tr className={`facts-row ${fact.effectiveStatus}`}>
                  <td className="facts-id" data-label="Fact">{fact.id}</td>
                  <td className="facts-claim" data-label="Claim" title={fact.claimText}>{fact.claimText}</td>
                  <td className="facts-evidence" data-label="Evidence"><strong>{fact.sourceType.replaceAll("-", " ") || "Unspecified"}</strong><span>{fact.sourceDocument || "Evidence not recorded"}</span>{fact.sourceRef && <small>{fact.sourceRef}</small>}</td>
                  <td className="facts-scope" data-label="Scope">
                    <div className="facts-scope-content">
                      {fact.topics.map((topic) => <span className="facts-chip" key={topic}>{topic}</span>)}
                      {fact.jurisdiction && <span className="facts-chip facts-jurisdiction">{fact.jurisdiction}</span>}
                      {fact.highRisk && <span className="facts-risk">High risk</span>}
                      {!fact.topics.length && !fact.jurisdiction && !fact.highRisk && <small>—</small>}
                    </div>
                  </td>
                  <td data-label="Status"><span className={`facts-pill ${fact.effectiveStatus}`} aria-label={fact.effectiveStatus} title={fact.statusExplanation}><Icon size={12} aria-hidden="true" />{fact.effectiveStatus !== "approved" && <span>{fact.effectiveStatus}</span>}</span>{fact.status !== fact.effectiveStatus && <small className="facts-stored">stored: {fact.status}</small>}</td>
                  <td data-label="Verified">{fact.verifiedAt || "—"}</td>
                  <td data-label="Review date">{fact.expiryOrReviewAt || "—"}</td>
                  <td data-label="Days left"><span className={`facts-days ${daysLeftTone(fact.daysLeft)}`}>{daysLeftLabel(fact.daysLeft)}</span></td>
                  <td className="facts-actions" data-label="Actions">
                    <button className="ghost facts-action-trigger" type="button" disabled={Boolean(busyFactId)} onClick={() => setActionMenuFactId((current) => current === fact.id ? "" : fact.id)} aria-expanded={actionMenuFactId === fact.id} aria-controls={`fact-actions-${fact.id}`}>
                      <MoreHorizontal size={15} /> Actions
                    </button>
                    {actionMenuFactId === fact.id && <div className="facts-action-menu" id={`fact-actions-${fact.id}`} aria-label={`Actions for ${fact.id}`}>
                      {isAdmin && <button className="ghost facts-action-edit" type="button" onClick={() => { setActionMenuFactId(""); editFact(fact); }} title="Edit evidence and review settings; all changes are audited">
                        <Pencil size={14} /> Edit evidence
                      </button>}
                      <button className="primary facts-action-approve" type="button" disabled={!isAdmin || Boolean(busyFactId) || fact.effectiveStatus === "approved"} onClick={() => { setActionMenuFactId(""); beginApproval(fact); }} title={isAdmin ? actionTitle : "Only an administrator can change fact approval"}>
                        <CheckCircle2 size={14} /> {busyFactId === fact.id ? "Working…" : actionLabel}
                      </button>
                      <button className="ghost facts-action-audit" type="button" onClick={() => { setActionMenuFactId(""); setEditingId(""); setEditDraft(null); void toggleAudit(fact); }} aria-expanded={expandedId === fact.id}>
                        <History size={14} /> Audit history
                      </button>
                    </div>}
                  </td>
                </tr>
                {expandedId === fact.id && <tr className="facts-audit-row">
                  <td colSpan={9}>
                    {editingId === fact.id && editDraft ? <form className="facts-editor" onSubmit={(event) => void saveFactEdit(event, fact)}>
                      <div className="facts-editor-head"><div><span className="facts-editor-kicker">EDIT REGISTER EVIDENCE</span><h3>{fact.id}</h3><p>Claim wording and figures stay tied to the multilingual brain. If evidence source or citation changes, an approved fact returns to pending review.</p></div><button className="ghost" type="button" onClick={() => { setEditingId(""); setEditDraft(null); setExpandedId(""); }} aria-label="Cancel fact edit"><X size={16} /></button></div>
                      <div className="facts-editor-grid">
                        <div className="facts-evidence-class"><span>REQUIRED EVIDENCE CLASS</span><strong>{fact.sourceType.replaceAll("-", " ")}</strong><small>This comes from the fact definition and cannot be changed here.</small></div>
                        <label>Evidence document or URL<input required maxLength={500} value={editDraft.sourceDocument} onChange={(event) => updateEdit({ sourceDocument: event.target.value })} /></label>
                        <label className="facts-editor-wide">Exact section, citation, or evidence note<input maxLength={500} value={editDraft.sourceRef} onChange={(event) => updateEdit({ sourceRef: event.target.value })} placeholder="Page, section, official notice, approved schedule…" /></label>
                        <label>Review every (days)<input type="number" min="1" max={fact.highRisk ? 90 : 365} value={editDraft.cadenceDays} onChange={(event) => updateEdit({ cadenceDays: event.target.value })} /></label>
                        <fieldset><legend>Approved answer languages</legend>{[["en", "English"], ["ar", "Arabic"], ["el", "Greek"]].map(([code, name]) => <label className="facts-language-option" key={code}><input type="checkbox" checked={editDraft.approvedLanguages.includes(code)} onChange={(event) => updateEdit({ approvedLanguages: event.target.checked ? [...editDraft.approvedLanguages, code] : editDraft.approvedLanguages.filter((language) => language !== code) })} /> {name}</label>)}</fieldset>
                        <label className="facts-editor-wide">Reviewer notes<textarea maxLength={2000} rows={3} value={editDraft.notes} onChange={(event) => updateEdit({ notes: event.target.value })} placeholder="Limits, conditions, and context for future reviewers." /></label>
                        <label className="facts-editor-wide">Reason for this change<textarea required maxLength={500} rows={2} value={editDraft.reason} onChange={(event) => updateEdit({ reason: event.target.value })} placeholder="Why are these evidence or review details changing?" /></label>
                      </div>
                      <div className="facts-editor-actions"><small>Saved by your signed-in admin account to the append-only audit trail.</small><button className="primary" type="submit" disabled={Boolean(busyFactId) || !editDraft.reason.trim() || !editDraft.approvedLanguages.length}><Save size={14} /> {busyFactId === fact.id ? "Saving…" : "Save review details"}</button></div>
                    </form> : approvalFactId === fact.id ? <form className="facts-editor facts-approval" onSubmit={(event) => { event.preventDefault(); void reapprove(fact, approvalReason); }}>
                      <div className="facts-editor-head"><div><span className="facts-editor-kicker">EVIDENCE REVIEW</span><h3>{fact.status === "pending" ? "Approve this fact" : fact.effectiveStatus === "expired" ? "Re-approve this fact" : "Re-enable this fact"}</h3><p>Confirm the current source and enter what you checked. The reviewer is recorded from your signed-in admin account.</p><p className="facts-approval-source"><strong>Source:</strong> {fact.sourceDocument || "Not recorded"} · <strong>Citation:</strong> {fact.sourceRef || "Not recorded"}</p></div><button className="ghost" type="button" onClick={() => { setApprovalFactId(""); setApprovalReason(""); setExpandedId(""); }} aria-label="Cancel approval"><X size={16} /></button></div>
                      <label className="facts-approval-reason">Evidence checked and decision reason<textarea required maxLength={500} rows={3} value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} placeholder="For example: checked the current Cyprus authority notice, section 4, published on …" /></label>
                      <div className="facts-editor-actions"><small>Owner-manual-only evidence cannot be approved. Update the source and citation first.</small><button className="primary" type="submit" disabled={Boolean(busyFactId) || !approvalReason.trim()}><CheckCircle2 size={14} /> {busyFactId === fact.id ? "Approving…" : "Confirm approval"}</button></div>
                    </form> : <div className="facts-audit">
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
                    </div>}
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
