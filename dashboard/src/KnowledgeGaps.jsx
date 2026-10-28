import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileQuestion, Link2, RefreshCcw, Search, ShieldCheck, X } from "lucide-react";
import "./knowledge-gaps.css";

// Knowledge Gaps: questions REFAL could not answer from approved knowledge.
// Reads are open to signed-in dashboard users; every action needs an admin and
// is audited server-side. Creating knowledge only opens the existing editor
// with a prefilled DRAFT; it is saved pending and approved by a human.

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.payload = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

const PRIORITY_LABELS = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const LANGUAGE_LABELS = { en: "English", ar: "Arabic", el: "Greek", und: "Unknown" };
const CATEGORY_LABEL = (value) => String(value || "general").replace(/_/gu, " ");
const EMPTY_FILTERS = { q: "", status: "active", category: "all", priority: "all", language: "all", intent: "all", owner: "all", reason: "all", from: "", to: "" };

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Metric({ label, value, tone = "" }) {
  return <div className={`gap-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Trend({ points = [] }) {
  const max = Math.max(1, ...points.map((point) => point.count));
  return <div className="gap-trend" aria-label="Gap questions per day, last 14 days">
    {points.map((point) => <span key={point.day} title={`${point.day}: ${point.count}`} style={{ height: `${Math.max(4, (point.count / max) * 100)}%` }} />)}
  </div>;
}

function CountList({ items = [], format = (value) => value, empty = "None" }) {
  if (!items.length) return <span className="gap-muted">{empty}</span>;
  return <ul className="gap-count-list">{items.map((item) => <li key={item.key}><span>{format(item.key)}</span><b>{item.count}</b></li>)}</ul>;
}

export default function KnowledgeGaps({ isAdmin, onCreateKnowledge, onOpenKnowledgeSource }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [data, setData] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");

  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value && value !== "all")).toString(), [filters]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [configValue, listValue] = await Promise.all([config ? Promise.resolve(config) : request("/api/knowledge-gaps/config"), request(`/api/knowledge-gaps?${query}`)]);
      setConfig(configValue); setData(listValue);
    } catch (value) {
      setError(value.payload?.migrationApplied === false ? "The Knowledge Gaps migration has not been applied in this environment yet." : value.message);
    } finally { setLoading(false); }
  }, [query, config]);
  useEffect(() => { const timer = setTimeout(load, 200); return () => clearTimeout(timer); }, [load]);

  const metrics = data?.metrics;
  const facets = data?.facets || {};
  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  return <div className="page-stack knowledge-gaps-page">
    <section className="gap-intro">
      <div>
        <span className="eyebrow"><FileQuestion size={14} /> QUESTIONS REFAL COULD NOT ANSWER</span>
        <h2>Knowledge gaps</h2>
        <p>Grouped by meaning across languages. Customer details are removed before anything is stored. REFAL never publishes knowledge from a gap: every new entry is a draft that an administrator reviews and approves.</p>
      </div>
      <button type="button" className="ghost" onClick={load} disabled={loading}><RefreshCcw size={14} /> Refresh</button>
    </section>

    {error && <div className="notice error"><AlertTriangle size={16} /> {error}</div>}

    {metrics && <section className="gap-metrics" aria-label="Knowledge gap summary">
      <Metric label="Open gaps" value={metrics.openGaps} />
      <Metric label="New this week" value={metrics.newThisWeek} />
      <Metric label="Questions affected" value={metrics.questionsAffected} />
      <Metric label="High priority" value={metrics.highPriority} tone={metrics.highPriority ? "warn" : ""} />
      <Metric label="Resolved this month" value={metrics.resolvedThisMonth} tone="ok" />
      <Metric label="Missing knowledge vs retrieval" value={`${metrics.missingKnowledge} / ${metrics.retrievalFailures}`} />
      <div className="gap-metric wide"><span>Top languages</span><CountList items={metrics.topLanguages} format={(key) => LANGUAGE_LABELS[key] || key} /></div>
      <div className="gap-metric wide"><span>Top categories</span><CountList items={metrics.topCategories} format={CATEGORY_LABEL} /></div>
      <div className="gap-metric wide"><span>Last 14 days</span><Trend points={metrics.trend} /></div>
    </section>}

    <section className="gap-filters" aria-label="Filter knowledge gaps">
      <label className="gap-search"><Search size={15} /><input value={filters.q} onChange={set("q")} placeholder="Search gaps, example questions, linked chunks" /></label>
      <select value={filters.status} onChange={set("status")} aria-label="Status">
        <option value="active">All active</option><option value="all">All statuses</option>
        {(config?.statuses || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <select value={filters.priority} onChange={set("priority")} aria-label="Priority"><option value="all">Any priority</option>
        {Object.entries(PRIORITY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <select value={filters.category} onChange={set("category")} aria-label="Category"><option value="all">Any category</option>
        {(facets.categories || []).map((item) => <option key={item} value={item}>{CATEGORY_LABEL(item)}</option>)}</select>
      <select value={filters.reason} onChange={set("reason")} aria-label="Reason"><option value="all">Any reason</option>
        {(config?.reasons || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      <select value={filters.language} onChange={set("language")} aria-label="Language"><option value="all">Any language</option>
        {(facets.languages || []).map((item) => <option key={item} value={item}>{LANGUAGE_LABELS[item] || item}</option>)}</select>
      <select value={filters.intent} onChange={set("intent")} aria-label="Intent"><option value="all">Any intent</option>
        {(facets.intents || []).map((item) => <option key={item} value={item}>{CATEGORY_LABEL(item)}</option>)}</select>
      <select value={filters.owner} onChange={set("owner")} aria-label="Owner"><option value="all">Any owner</option><option value="unassigned">Unassigned</option>
        {(facets.owners || []).map((item) => <option key={item} value={item}>{item}</option>)}</select>
      <label className="gap-date">From <input type="date" value={filters.from} onChange={set("from")} /></label>
      <label className="gap-date">To <input type="date" value={filters.to} onChange={set("to")} /></label>
      <button type="button" className="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
    </section>

    <section className="gap-table-wrap">
      {loading && !data ? <p className="gap-muted">Loading knowledge gaps…</p> : <table className="gap-table">
        <thead><tr><th>Gap</th><th>Category</th><th>Number of questions</th><th>Languages</th><th>Priority</th><th>First seen</th><th>Last seen</th><th>Status</th><th>Owner</th><th>Actions</th></tr></thead>
        <tbody>
          {(data?.groups || []).map((group) => <tr key={group.id}>
            <td><button type="button" className="gap-link" onClick={() => setSelectedId(group.id)}>{group.title}</button><small>{group.reasonLabel}{group.linkedCount ? ` · ${group.linkedCount} linked` : ""}</small></td>
            <td>{CATEGORY_LABEL(group.category)}</td>
            <td>{group.occurrence_count}{group.suppressed_count ? <small> +{group.suppressed_count} repeats</small> : null}</td>
            <td>{(group.languages || []).map((language) => LANGUAGE_LABELS[language] || language).join(", ")}</td>
            <td><span className={`gap-priority ${group.priority}`}>{PRIORITY_LABELS[group.priority]}{group.priorityOverridden ? " (set)" : ""}</span></td>
            <td>{formatDate(group.first_seen_at)}</td>
            <td>{formatDate(group.last_seen_at)}</td>
            <td><span className={`gap-status ${group.status}`}>{group.statusLabel}</span></td>
            <td>{group.owner || <span className="gap-muted">Unassigned</span>}</td>
            <td><button type="button" className="ghost" onClick={() => setSelectedId(group.id)}>Open</button></td>
          </tr>)}
          {data && !data.groups.length && <tr><td colSpan={10} className="gap-muted">No knowledge gaps match these filters.</td></tr>}
        </tbody>
      </table>}
    </section>

    {selectedId && <GapDetails id={selectedId} isAdmin={isAdmin && config?.canManage !== false} onClose={() => setSelectedId("")} onChanged={load}
      onCreateKnowledge={onCreateKnowledge} onOpenKnowledgeSource={onOpenKnowledgeSource} />}
  </div>;
}

function GapDetails({ id, isAdmin, onClose, onChanged, onCreateKnowledge, onOpenKnowledgeSource }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");
  const [owner, setOwner] = useState("");
  const [priority, setPriority] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [selectedChunks, setSelectedChunks] = useState([]);
  const [markWeak, setMarkWeak] = useState(false);
  const [verification, setVerification] = useState(null);

  const reload = useCallback(async () => {
    try { const value = await request(`/api/knowledge-gaps/${id}`); setDetail(value); setOwner(value.group.owner || ""); setPriority(value.group.priority_override || ""); setSearchText(value.group.title || ""); }
    catch (value) { setError(value.message); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function act(action, extra = {}) {
    setBusy(action); setError(""); setNotice("");
    try {
      const value = await request(`/api/knowledge-gaps/${id}/actions`, { method: "POST", body: JSON.stringify({ action, reason, ...extra }) });
      if (value.verification) setVerification(value.verification);
      if (action === "create_knowledge" && value.prefill) { onCreateKnowledge?.(value.prefill); return; }
      if (action === "improve_existing" && value.openSourceId) { onOpenKnowledgeSource?.(value.openSourceId); return; }
      setNotice(action === "link_existing" ? `Linked. ${value.result?.linksAdded || 0} new link(s); ${value.result?.testsUpserted || 0} regression test(s) saved.` : "Saved.");
      setReason(""); setSelectedChunks([]);
      await reload(); onChanged?.();
    } catch (value) {
      if (value.payload?.verification) setVerification(value.payload.verification);
      setError(value.message);
    } finally { setBusy(""); }
  }

  async function verify() {
    setBusy("verify"); setError(""); setNotice("");
    try { const value = await request(`/api/knowledge-gaps/${id}/verify`, { method: "POST", body: "{}" }); setVerification(value.verification); await reload(); }
    catch (value) { setError(value.message); }
    finally { setBusy(""); }
  }

  async function searchKnowledge(event) {
    event.preventDefault();
    setBusy("search"); setError("");
    try {
      const value = await request("/api/knowledge/search", { method: "POST", body: JSON.stringify({ query: searchText }) });
      setSearchResults((value.results || []).filter((row) => row.chunk_id && row.review_status !== "pending"));
    } catch (value) { setError(value.message); }
    finally { setBusy(""); }
  }

  if (!detail) return <div className="gap-modal-backdrop" role="presentation"><div className="gap-modal" role="dialog" aria-modal="true" aria-label="Knowledge gap details">
    <header><h3>Knowledge gap</h3><button type="button" className="ghost" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
    {error ? <div className="notice error">{error}</div> : <p className="gap-muted">Loading…</p>}
  </div></div>;

  const { group, examples, diagnostics, links, regressionTests, audit } = detail;
  const status = group.status;
  const closed = ["resolved", "verified", "ignored"].includes(status);
  const toggleChunk = (chunkId) => setSelectedChunks((current) => current.includes(chunkId) ? current.filter((item) => item !== chunkId) : [...current, chunkId].slice(0, 10));

  return <div className="gap-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="gap-modal" role="dialog" aria-modal="true" aria-label={`Knowledge gap: ${group.title}`}>
      <header>
        <div><span className={`gap-status ${status}`}>{group.statusLabel}</span> <span className={`gap-priority ${group.priority}`}>{PRIORITY_LABELS[group.priority]}</span>
          <h3>{group.title}</h3>
          <p className="gap-muted">{group.reasonLabel} · {CATEGORY_LABEL(group.category)}{group.intent ? ` · ${CATEGORY_LABEL(group.intent)}` : ""} · {group.occurrence_count} question(s) from {group.distinctContacts} conversation(s) · {(group.languages || []).map((language) => LANGUAGE_LABELS[language] || language).join(", ")}</p>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      {error && <div className="notice error"><AlertTriangle size={16} /> {error}</div>}
      {notice && <div className="notice success"><CheckCircle2 size={16} /> {notice}</div>}

      <section className={`gap-hint ${diagnostics.hint.code}`}><strong>{diagnostics.hint.label}</strong><span>{diagnostics.hint.explanation}</span></section>

      <div className="gap-detail-grid">
        <section>
          <h4>Recent examples</h4>
          <ul className="gap-examples">{examples.map((item) => <li key={item.id}>
            <p>{item.question}</p>
            <small>{formatDate(item.at)} · {LANGUAGE_LABELS[item.language] || item.language} · {item.conversation} · {item.reasonLabel} ({item.confidence}) · {item.responseType}</small>
          </li>)}</ul>
        </section>
        <section>
          <h4>Retrieval diagnostics</h4>
          <dl className="gap-dl">
            <dt>Approved search ran</dt><dd>{Math.round(diagnostics.searchRanShare * 100)}% of turns</dd>
            <dt>Returned evidence</dt><dd>{Math.round(diagnostics.evidenceShare * 100)}% of turns</dd>
            <dt>Reranker</dt><dd><CountList items={diagnostics.rerank} /></dd>
          </dl>
          <h5>Search queries</h5><CountList items={diagnostics.queries} empty="No search ran" />
          <h5>Top chunks (best rank · mean relevance)</h5>
          {diagnostics.topChunks.length ? <ul className="gap-count-list">{diagnostics.topChunks.map((chunk) => <li key={chunk.id}><code>{chunk.id}</code><b>#{chunk.bestRank ?? "?"} · {chunk.meanRelevance ?? "?"} · seen {chunk.seen}x</b></li>)}</ul> : <span className="gap-muted">No chunk was returned</span>}
          <h5>Expected knowledge (linked)</h5>
          {diagnostics.expectedKnowledge.length ? <ul className="gap-count-list">{diagnostics.expectedKnowledge.map((item) => <li key={item.chunkId}><span>{item.label || item.chunkId}</span><b>top {item.retrievedInTop}/{item.events} · candidate {item.retrievedAsCandidate}/{item.events}</b></li>)}</ul> : <span className="gap-muted">No chunk linked yet</span>}
          <h5>Grounding</h5><p className="gap-muted">Rejected in {Math.round(diagnostics.grounding.rejectedShare * 100)}% of turns</p><CountList items={diagnostics.grounding.reasons} />
        </section>
        <section>
          <h4>Agent diagnostics</h4>
          <h5>Model</h5><CountList items={diagnostics.agent.models} />
          <h5>Final response type</h5><CountList items={diagnostics.agent.responseTypes} />
          <h5>Outcome</h5><CountList items={diagnostics.agent.outcomes} />
          <h5>Prompt version</h5><CountList items={diagnostics.agent.promptVersions} />
          <h5>Reason per question</h5><CountList items={diagnostics.reasons} />
          <h5>Priority factors</h5>
          <p className="gap-muted">{group.priorityOverridden ? "Set by an administrator." : Object.entries(group.priorityFactors || {}).map(([key, value]) => `${key} ${value}`).join(" · ")}</p>
        </section>
      </div>

      <section>
        <h4>Linked knowledge and regression tests</h4>
        {links.length ? <ul className="gap-count-list">{links.map((link) => <li key={link.id}><span><Link2 size={13} /> {link.label || link.chunk_id || link.document_id} <small>({link.link_type}{link.weak_retrieval ? ", weak retrieval" : ""})</small></span><b>{link.linked_by}</b></li>)}</ul> : <p className="gap-muted">Nothing linked yet.</p>}
        {regressionTests.length > 0 && <table className="gap-table compact"><thead><tr><th>Query</th><th>Min rank</th><th>Last result</th><th>Rank</th><th>Last run</th></tr></thead><tbody>
          {regressionTests.map((test) => <tr key={test.id}><td>{test.query}</td><td>{test.expected_min_rank}</td><td><span className={`gap-test ${test.last_result}`}>{test.last_result}</span></td><td>{test.last_rank ?? "—"}</td><td>{formatDate(test.last_run_at)}</td></tr>)}
        </tbody></table>}
        {verification && <p className={verification.passed ? "notice success" : "notice error"}>
          Verification: {verification.ran || 0} test(s), retrieval {verification.retrievalPassed ? "passed" : "failed"}; agent check {verification.agent?.status || "not_run"}.
        </p>}
      </section>

      {isAdmin && <section className="gap-actions">
        <h4>Actions</h4>
        <label className="gap-reason">Reason (recorded in the audit log)<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} /></label>
        <div className="gap-action-row">
          {status === "open" && <button type="button" disabled={Boolean(busy)} onClick={() => act("start_review")}>Start review</button>}
          {!closed && <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => act("create_knowledge")}>Create knowledge from gap</button>}
          {!closed && status !== "needs_retrieval_fix" && <button type="button" disabled={Boolean(busy)} onClick={() => act("mark_retrieval_issue")}>Mark as retrieval issue</button>}
          {!closed && status !== "needs_agent_fix" && <button type="button" disabled={Boolean(busy)} onClick={() => act("mark_agent_issue")}>Mark as agent issue</button>}
          {!closed && <button type="button" disabled={Boolean(busy) || !reason.trim()} onClick={() => act("resolve")} title="Linked knowledge must pass retrieval verification first"><ShieldCheck size={14} /> Resolve</button>}
          {regressionTests.length > 0 && <button type="button" disabled={Boolean(busy)} onClick={verify}>Verify now</button>}
          {!closed && <button type="button" className="danger" disabled={Boolean(busy) || !reason.trim()} onClick={() => act("ignore")}>Ignore</button>}
          {closed && <button type="button" disabled={Boolean(busy) || !reason.trim()} onClick={() => act("reopen")}>Reopen</button>}
        </div>
        <div className="gap-action-row">
          <label>Owner <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="admin@example.com" /></label>
          <button type="button" disabled={Boolean(busy)} onClick={() => act("assign", { owner })}>Assign</button>
          <label>Priority <select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">Automatic</option>
            {Object.entries(PRIORITY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button type="button" disabled={Boolean(busy)} onClick={() => act("set_priority", { priority })}>Set priority</button>
        </div>
        {!closed && <form className="gap-link-form" onSubmit={searchKnowledge}>
          <h5>Link or improve existing knowledge</h5>
          <div className="gap-action-row"><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search approved knowledge" />
            <button type="submit" disabled={Boolean(busy) || !searchText.trim()}><Search size={14} /> Search</button></div>
          {searchResults.length > 0 && <ul className="gap-search-results">{searchResults.map((row) => <li key={row.chunk_id}>
            <label><input type="checkbox" checked={selectedChunks.includes(row.chunk_id)} onChange={() => toggleChunk(row.chunk_id)} />
              <span><strong>{row.document_title || row.source_name}</strong>{row.heading ? ` · ${row.heading}` : ""}<small>{String(row.content || "").slice(0, 220)}</small></span></label>
            <button type="button" className="ghost" disabled={Boolean(busy)} onClick={() => act("improve_existing", { documentId: row.document_id })}>Improve this entry</button>
          </li>)}</ul>}
          <div className="gap-action-row">
            <label><input type="checkbox" checked={markWeak} onChange={(event) => setMarkWeak(event.target.checked)} /> The knowledge existed: mark as weak retrieval</label>
            <button type="button" disabled={Boolean(busy) || !selectedChunks.length} onClick={() => act("link_existing", { chunkIds: selectedChunks, markWeakRetrieval: markWeak })}>
              <Link2 size={14} /> Link {selectedChunks.length || ""} selected</button>
          </div>
          <p className="gap-muted">Linking stores a reference only, never a copy of the content. The gap's questions become regression tests that must find the linked knowledge within rank 5.</p>
        </form>}
      </section>}

      <section>
        <h4>Audit</h4>
        {audit.length ? <ul className="gap-count-list">{audit.map((entry) => <li key={entry.id}><span>{entry.action.replace(/_/gu, " ")} {entry.previous_status !== entry.new_status ? `(${entry.previous_status} → ${entry.new_status})` : ""}{entry.reason ? `: ${entry.reason}` : ""}</span><b>{entry.actor} · {formatDate(entry.created_at)}</b></li>)}</ul> : <p className="gap-muted">No actions yet.</p>}
      </section>
    </div>
  </div>;
}
