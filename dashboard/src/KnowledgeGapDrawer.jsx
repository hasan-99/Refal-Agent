import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Bot, CheckCircle2, ChevronDown, Database, History, Lightbulb, Link2, ListChecks, MessageSquare,
  PlusCircle, Search, ShieldCheck, UserRound, Wrench, X
} from "lucide-react";
import { DrawerShell, DrawerSkeleton, request } from "./KnowledgeGapShell.jsx";
import { LANGUAGE_SHORT, PRIORITY_LABELS, humanize, percent, relativeTime } from "./knowledgeGapsView.js";

// Lazily loaded details drawer for one knowledge gap. Sections are collapsible
// and render their content only once opened.

const HINT_TONE = { missing_knowledge: "info", partial_knowledge: "info", weak_retrieval: "warn", chunk_needs_improvement: "warn",
  agent_logic: "warn", system: "danger", no_events: "muted" };

export default function KnowledgeGapDrawer({ id, isAdmin, onClose, onChanged, onCreateKnowledge, onOpenKnowledgeSource }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [verification, setVerification] = useState(null);
  const closeButton = useRef(null);

  const reload = useCallback(async () => {
    try { setDetail(await request(`/api/knowledge-gaps/${id}`)); }
    catch (value) { setError(value.message); }
  }, [id]);
  useEffect(() => { setDetail(null); setError(""); setNotice(""); setVerification(null); reload(); }, [reload]);
  useEffect(() => { closeButton.current?.focus(); }, [detail]);

  async function act(action, extra = {}) {
    setBusy(action); setError(""); setNotice("");
    try {
      const value = await request(`/api/knowledge-gaps/${id}/actions`, { method: "POST", body: JSON.stringify({ action, ...extra }) });
      if (value.verification) setVerification(value.verification);
      if (action === "create_knowledge" && value.prefill) { onCreateKnowledge?.(value.prefill); return true; }
      if (action === "improve_existing" && value.openSourceId) { onOpenKnowledgeSource?.(value.openSourceId); return true; }
      setNotice(action === "link_existing" ? `Linked. ${value.result?.linksAdded || 0} new link(s), ${value.result?.testsUpserted || 0} regression test(s) saved.` : "Saved.");
      await reload(); onChanged?.();
      return true;
    } catch (value) {
      if (value.payload?.verification) setVerification(value.payload.verification);
      setError(value.message);
      return false;
    } finally { setBusy(""); }
  }

  async function verify() {
    setBusy("verify"); setError(""); setNotice("");
    try { const value = await request(`/api/knowledge-gaps/${id}/verify`, { method: "POST", body: "{}" }); setVerification(value.verification); await reload(); }
    catch (value) { setError(value.message); }
    finally { setBusy(""); }
  }

  if (!detail) {
    return <DrawerShell onClose={onClose}>
      {error ? <><DrawerHead onClose={onClose} closeRef={closeButton} title="Knowledge gap" /><div className="kg-drawer-body"><Notice tone="error">{error}</Notice></div></>
        : <DrawerSkeleton onClose={onClose} />}
    </DrawerShell>;
  }

  const { group, examples, diagnostics, links, regressionTests, audit } = detail;
  const closed = ["resolved", "verified", "ignored"].includes(group.status);
  const hintTone = HINT_TONE[diagnostics.hint.code] || "info";

  return <DrawerShell onClose={onClose} label={`Knowledge gap: ${group.title}`}>
    <DrawerHead onClose={onClose} closeRef={closeButton} title={group.title}>
      <span className="kg-card-tags">
        <span className={`kg-pill priority ${group.priority}`}>{PRIORITY_LABELS[group.priority]}{group.priorityOverridden ? " · set" : ""}</span>
        <span className={`kg-pill status ${group.status}`}>{group.statusLabel}</span>
        <span className="kg-pill reason">{group.reasonLabel}</span>
      </span>
      <span className="kg-drawer-meta">
        {group.occurrence_count} question{group.occurrence_count === 1 ? "" : "s"} · {group.distinctContacts} conversation{group.distinctContacts === 1 ? "" : "s"} · {humanize(group.category)}
        {group.intent ? ` · ${humanize(group.intent)}` : ""} · last seen {relativeTime(group.last_seen_at)}
      </span>
    </DrawerHead>

    <div className="kg-drawer-body">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      <section className={`kg-diagnosis ${hintTone}`}>
        <span className="kg-diagnosis-icon"><Lightbulb size={18} /></span>
        <span><strong>{diagnostics.hint.label}</strong><small>{diagnostics.hint.explanation}</small></span>
      </section>

      <div className="kg-quick-stats">
        <QuickStat label="Search ran" value={percent(diagnostics.searchRanShare)} />
        <QuickStat label="Found evidence" value={percent(diagnostics.evidenceShare)} />
        <QuickStat label="Draft rejected" value={percent(diagnostics.grounding.rejectedShare)} />
        <QuickStat label="Linked" value={links.length} />
      </div>

      {isAdmin && <Section icon={Wrench} title="Take action" defaultOpen>
        <ActionPanel group={group} closed={closed} busy={busy} act={act} verify={verify} hasTests={regressionTests.length > 0} />
      </Section>}

      <Section icon={MessageSquare} title="Customer questions" count={examples.length} defaultOpen>
        <ul className="kg-questions">{examples.map((item) => <li key={item.id}>
          <p dir="auto">{item.question}</p>
          <small><span className="kg-lang">{LANGUAGE_SHORT[item.language] || item.language}</span> {relativeTime(item.at)} · {item.conversation} · {item.reasonLabel}</small>
        </li>)}</ul>
      </Section>

      <Section icon={Database} title="Retrieval diagnostics">
        <dl className="kg-dl">
          <dt>Reranker</dt><dd><Counts items={diagnostics.rerank} /></dd>
          <dt>Search queries</dt><dd><Counts items={diagnostics.queries} empty="No search ran" /></dd>
          <dt>Grounding rejections</dt><dd><Counts items={diagnostics.grounding.reasons} empty="None" /></dd>
        </dl>
        <h5>Top retrieved chunks</h5>
        {diagnostics.topChunks.length ? <ul className="kg-rows">{diagnostics.topChunks.map((chunk) => <li key={chunk.id}>
          <code>{chunk.id.slice(0, 8)}</code><span>best rank #{chunk.bestRank ?? "?"} · relevance {chunk.meanRelevance ?? "?"} · seen {chunk.seen}×</span>
        </li>)}</ul> : <p className="kg-muted">No chunk was returned.</p>}
        {diagnostics.expectedKnowledge.length > 0 && <>
          <h5>Linked knowledge in results</h5>
          <ul className="kg-rows">{diagnostics.expectedKnowledge.map((item) => <li key={item.chunkId}>
            <span>{item.label || item.chunkId}</span><span>top {item.retrievedInTop}/{item.events} · candidate {item.retrievedAsCandidate}/{item.events}</span>
          </li>)}</ul>
        </>}
      </Section>

      <Section icon={Bot} title="Agent diagnostics">
        <dl className="kg-dl">
          <dt>Outcome</dt><dd><Counts items={diagnostics.agent.outcomes} /></dd>
          <dt>Response type</dt><dd><Counts items={diagnostics.agent.responseTypes} /></dd>
          <dt>Model</dt><dd><Counts items={diagnostics.agent.models} /></dd>
          <dt>Prompt version</dt><dd><Counts items={diagnostics.agent.promptVersions} /></dd>
          <dt>Priority factors</dt><dd>{group.priorityOverridden ? "Set by an administrator" : Object.entries(group.priorityFactors || {}).map(([key, value]) => `${key} ${value}`).join(" · ") || "—"}</dd>
        </dl>
      </Section>

      <Section icon={ListChecks} title="Linked knowledge and tests" count={links.length + regressionTests.length}>
        {links.length ? <ul className="kg-rows">{links.map((link) => <li key={link.id}>
          <span><Link2 size={13} /> {link.label || link.chunk_id || link.document_id}</span>
          <span>{humanize(link.link_type)}{link.weak_retrieval ? " · weak retrieval" : ""} · {link.linked_by}</span>
        </li>)}</ul> : <p className="kg-muted">Nothing linked yet. Link existing knowledge or create a new entry to turn these questions into regression tests.</p>}
        {regressionTests.length > 0 && <ul className="kg-rows tests">{regressionTests.map((test) => <li key={test.id}>
          <span dir="auto">{test.query}</span>
          <span className={`kg-pill test ${test.last_result || "never"}`}>{test.last_result || "not run"}{test.last_rank ? ` · #${test.last_rank}` : ""}</span>
        </li>)}</ul>}
        {verification && <Notice tone={verification.passed ? "success" : "error"}>
          Verification: {verification.ran || 0} test(s), retrieval {verification.retrievalPassed ? "passed" : "failed"}; agent check {verification.agent?.status || "not run"}.
        </Notice>}
      </Section>

      <Section icon={History} title="Activity" count={audit.length}>
        {audit.length ? <ol className="kg-timeline">{audit.map((entry) => <li key={entry.id}>
          <strong>{humanize(entry.action)}</strong>
          {entry.previous_status !== entry.new_status && <span className="kg-muted"> {entry.previous_status} → {entry.new_status}</span>}
          {entry.reason && <p>{entry.reason}</p>}
          <small><UserRound size={11} /> {entry.actor} · {relativeTime(entry.created_at)}</small>
        </li>)}</ol> : <p className="kg-muted">No actions yet.</p>}
      </Section>
    </div>
  </DrawerShell>;
}

function DrawerHead({ title, onClose, closeRef, children }) {
  return <header className="kg-drawer-head">
    <div className="kg-drawer-title">{children && React.Children.toArray(children)[0]}<h3 dir="auto">{title}</h3>{children && React.Children.toArray(children).slice(1)}</div>
    <button ref={closeRef} type="button" className="kg-icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
  </header>;
}

// Accordion section: content is rendered only after the first open.
function Section({ icon: Icon, title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const [rendered, setRendered] = useState(defaultOpen);
  return <section className={`kg-section${open ? " open" : ""}`}>
    <button type="button" className="kg-section-head" aria-expanded={open} onClick={() => { setOpen((value) => !value); setRendered(true); }}>
      <Icon size={16} /><span>{title}</span>{Number.isInteger(count) && <span className="kg-count">{count}</span>}<ChevronDown size={16} className="kg-chevron" />
    </button>
    {rendered && <div className="kg-section-body" hidden={!open}>{children}</div>}
  </section>;
}

function ActionPanel({ group, closed, busy, act, verify, hasTests }) {
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState("");
  const [owner, setOwner] = useState(group.owner || "");
  const [priority, setPriority] = useState(group.priority_override || "");
  const needsReason = ["resolve", "ignore", "reopen"].includes(mode);
  const run = async (action, extra) => { if (await act(action, { reason, ...extra })) { setReason(""); setMode(""); } };

  return <div className="kg-actions">
    {!closed && <div className="kg-action-grid">
      <button type="button" className="kg-action primary" disabled={Boolean(busy)} onClick={() => run("create_knowledge")}>
        <PlusCircle size={16} /><span><strong>Create knowledge</strong><small>Opens a draft for review</small></span></button>
      <button type="button" className={`kg-action${mode === "link" ? " selected" : ""}`} disabled={Boolean(busy)} onClick={() => setMode(mode === "link" ? "" : "link")}>
        <Link2 size={16} /><span><strong>Link existing</strong><small>The answer already exists</small></span></button>
      {group.status !== "needs_retrieval_fix" && <button type="button" className="kg-action" disabled={Boolean(busy)} onClick={() => run("mark_retrieval_issue")}>
        <Search size={16} /><span><strong>Retrieval issue</strong><small>Search missed it</small></span></button>}
      {group.status !== "needs_agent_fix" && <button type="button" className="kg-action" disabled={Boolean(busy)} onClick={() => run("mark_agent_issue")}>
        <Bot size={16} /><span><strong>Agent issue</strong><small>Evidence was there</small></span></button>}
    </div>}

    {mode === "link" && !closed && <LinkKnowledge group={group} busy={busy} act={act} onDone={() => setMode("")} />}

    <div className="kg-action-row">
      {group.status === "open" && <button type="button" disabled={Boolean(busy)} onClick={() => run("start_review")}><Activity size={14} /> Start review</button>}
      {!closed && <button type="button" className={mode === "resolve" ? "selected" : ""} disabled={Boolean(busy)} onClick={() => setMode(mode === "resolve" ? "" : "resolve")}><ShieldCheck size={14} /> Resolve</button>}
      {hasTests && <button type="button" disabled={Boolean(busy)} onClick={verify}><CheckCircle2 size={14} /> Verify now</button>}
      {!closed && <button type="button" className={`danger-soft${mode === "ignore" ? " selected" : ""}`} disabled={Boolean(busy)} onClick={() => setMode(mode === "ignore" ? "" : "ignore")}>Ignore</button>}
      {closed && <button type="button" className={mode === "reopen" ? "selected" : ""} disabled={Boolean(busy)} onClick={() => setMode(mode === "reopen" ? "" : "reopen")}>Reopen</button>}
    </div>

    {needsReason && <div className="kg-reason">
      <label>Why? <span className="kg-muted">Recorded in the audit log.</span>
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} autoFocus
          placeholder={mode === "resolve" ? "e.g. Added the refund deadline to the approved policy" : "Short reason"} /></label>
      <div className="kg-action-row">
        <button type="button" className={mode === "ignore" ? "danger" : "primary"} disabled={Boolean(busy) || !reason.trim()} onClick={() => run(mode)}>
          {busy === mode ? "Saving…" : `Confirm ${mode}`}</button>
        <button type="button" className="kg-text-button" onClick={() => { setMode(""); setReason(""); }}>Cancel</button>
      </div>
      {mode === "resolve" && <p className="kg-muted">If knowledge is linked, its regression tests must pass before the gap can close.</p>}
    </div>}

    <details className="kg-more">
      <summary><UserRound size={14} /> Owner and priority</summary>
      <div className="kg-action-row">
        <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Owner email" aria-label="Owner" />
        <button type="button" disabled={Boolean(busy)} onClick={() => run("assign", { owner })}>Assign</button>
      </div>
      <div className="kg-action-row">
        <select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Priority">
          <option value="">Automatic priority</option>
          {Object.entries(PRIORITY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <button type="button" disabled={Boolean(busy)} onClick={() => run("set_priority", { priority })}>Set priority</button>
      </div>
    </details>
  </div>;
}

function LinkKnowledge({ group, busy, act, onDone }) {
  const [searchText, setSearchText] = useState(group.title || "");
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState([]);
  const [markWeak, setMarkWeak] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  async function search(event) {
    event.preventDefault();
    setSearching(true); setError("");
    try {
      const value = await request("/api/knowledge/search", { method: "POST", body: JSON.stringify({ query: searchText }) });
      setResults((value.results || []).filter((row) => row.chunk_id && row.review_status !== "pending"));
    } catch (value) { setError(value.message); }
    finally { setSearching(false); }
  }
  const toggle = (chunkId) => setSelected((current) => current.includes(chunkId) ? current.filter((item) => item !== chunkId) : [...current, chunkId].slice(0, 10));

  return <form className="kg-link" onSubmit={search}>
    <div className="kg-action-row">
      <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search approved knowledge" aria-label="Search approved knowledge" />
      <button type="submit" disabled={searching || !searchText.trim()}><Search size={14} /> {searching ? "Searching…" : "Search"}</button>
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    {searching && <span className="kg-skeleton-block" />}
    {results && !searching && (results.length ? <ul className="kg-link-results">{results.map((row) => <li key={row.chunk_id} className={selected.includes(row.chunk_id) ? "selected" : ""}>
      <label>
        <input type="checkbox" checked={selected.includes(row.chunk_id)} onChange={() => toggle(row.chunk_id)} />
        <span><strong dir="auto">{row.document_title || row.source_name}</strong>{row.heading ? <em dir="auto"> · {row.heading}</em> : null}
          <small dir="auto">{String(row.content || "").slice(0, 200)}</small></span>
      </label>
      <button type="button" className="kg-text-button" disabled={Boolean(busy)} onClick={() => act("improve_existing", { documentId: row.document_id })}>Improve</button>
    </li>)}</ul> : <p className="kg-muted">No approved knowledge matched. Try other words, or create a new entry.</p>)}
    <div className="kg-action-row">
      <label className="kg-check"><input type="checkbox" checked={markWeak} onChange={(event) => setMarkWeak(event.target.checked)} /> The answer existed: mark as weak retrieval</label>
      <button type="button" className="primary" disabled={Boolean(busy) || !selected.length}
        onClick={async () => { if (await act("link_existing", { chunkIds: selected, markWeakRetrieval: markWeak })) onDone(); }}>
        <Link2 size={14} /> Link {selected.length || ""} selected</button>
    </div>
    <p className="kg-muted">Linking stores a reference only. The gap&apos;s questions become regression tests that must find the linked knowledge within rank 5.</p>
  </form>;
}

function QuickStat({ label, value }) {
  return <div className="kg-quick"><strong>{value}</strong><span>{label}</span></div>;
}

function Counts({ items = [], empty = "—" }) {
  if (!items.length) return <span className="kg-muted">{empty}</span>;
  return <span className="kg-counts">{items.slice(0, 8).map((item) => <span key={item.key} className="kg-count-chip"><span dir="auto">{humanize(item.key)}</span><b>{item.count}</b></span>)}</span>;
}

function Notice({ tone, children }) {
  return <div className={`kg-notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
    {tone === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}<span>{children}</span>
  </div>;
}

