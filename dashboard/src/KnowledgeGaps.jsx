import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock, Flame, Inbox, Languages, Link2, MessageSquare,
  PauseCircle, Radio, RefreshCcw, Search, SlidersHorizontal, Sparkles, TrendingUp, Users, X
} from "lucide-react";
import {
  EMPTY_FILTERS, LANGUAGE_LABELS, LANGUAGE_SHORT, PRIORITY_LABELS, STATUS_TABS, activeFilterCount, buildListQuery,
  humanize, initials, mergePage, relativeTime, sparklinePath
} from "./knowledgeGapsView.js";
import { DrawerShell, request } from "./KnowledgeGapShell.jsx";
import "./knowledge-gaps.css";

// Knowledge Gaps: questions REFAL could not answer from approved knowledge.
// Reads are open to signed-in dashboard users; every action needs an admin and
// is audited server-side. Creating knowledge only opens the existing editor
// with a prefilled DRAFT; it is saved pending and approved by a human.

const loadDrawer = () => import("./KnowledgeGapDrawer.jsx");
const KnowledgeGapDrawer = React.lazy(loadDrawer);

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return debounced;
}

export default function KnowledgeGaps({ isAdmin, onCreateKnowledge, onOpenKnowledgeSource }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [summary, setSummary] = useState(null);
  const [groups, setGroups] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const requestSeq = useRef(0);
  const sentinel = useRef(null);

  const q = useDebounced(searchText.trim(), 300);
  const effectiveFilters = useMemo(() => ({ ...filters, q }), [filters, q]);

  useEffect(() => { request("/api/knowledge-gaps/config").then(setConfig).catch(() => setConfig(null)); }, []);

  // First page: replaces the list whenever the filters or the refresh key change.
  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true); setError("");
    request(`/api/knowledge-gaps?${buildListQuery(effectiveFilters, { offset: 0 })}`)
      .then((value) => {
        if (seq !== requestSeq.current) return;
        setGroups(value.groups || []); setNextOffset(value.nextOffset ?? null); setFilteredTotal(value.filteredTotal ?? (value.groups || []).length);
        setSummary({ metrics: value.metrics, facets: value.facets || {}, total: value.total ?? 0 });
      })
      .catch((value) => {
        if (seq !== requestSeq.current) return;
        setError(value.payload?.migrationApplied === false ? "The Knowledge Gaps migration has not been applied in this environment yet." : value.message);
      })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, [effectiveFilters, refreshKey]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || nextOffset === null) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    request(`/api/knowledge-gaps?${buildListQuery(effectiveFilters, { offset: nextOffset })}`)
      .then((value) => {
        if (seq !== requestSeq.current) return;
        setGroups((current) => mergePage(current, value.groups || [])); setNextOffset(value.nextOffset ?? null);
      })
      .catch((value) => { if (seq === requestSeq.current) setError(value.message); })
      .finally(() => setLoadingMore(false));
  }, [effectiveFilters, loading, loadingMore, nextOffset]);

  // Lazy loading: fetch the next page when the sentinel scrolls into view.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || nextOffset === null || typeof IntersectionObserver !== "function") return undefined;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadMore(); }, { rootMargin: "320px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, nextOffset]);

  const refresh = () => setRefreshKey((value) => value + 1);
  const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const clearAll = () => { setFilters(EMPTY_FILTERS); setSearchText(""); };
  const panelCount = activeFilterCount(filters);
  const anyFilter = panelCount > 0 || Boolean(q) || filters.status !== EMPTY_FILTERS.status;

  return <div className="kg-page">
    <header className="kg-hero">
      <div className="kg-hero-copy">
        <span className="kg-eyebrow"><Sparkles size={13} /> Knowledge gaps</span>
        <h2>Questions REFAL couldn&apos;t answer</h2>
        <p>Grouped by meaning across Arabic, English and Greek. Personal details are removed before anything is stored, and nothing is published without an administrator&apos;s approval.</p>
      </div>
      <div className="kg-hero-actions">
        <RecordingSwitch isAdmin={isAdmin} refreshKey={refreshKey} />
        <button type="button" className="kg-icon-button" onClick={refresh} disabled={loading} aria-label="Refresh" title="Refresh">
          <RefreshCcw size={16} className={loading ? "kg-spin" : ""} />
        </button>
      </div>
    </header>

    <StatsRow metrics={summary?.metrics} loading={loading && !summary} />

    <section className="kg-toolbar" aria-label="Find knowledge gaps">
      <label className="kg-search">
        <Search size={16} aria-hidden="true" />
        <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search questions, gaps or linked knowledge" aria-label="Search knowledge gaps" />
        {searchText && <button type="button" className="kg-search-clear" onClick={() => setSearchText("")} aria-label="Clear search"><X size={14} /></button>}
      </label>
      <div className="kg-segments" role="tablist" aria-label="Status">
        {STATUS_TABS.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={filters.status === tab.id}
          className={filters.status === tab.id ? "active" : ""} onClick={() => setFilter("status", tab.id)}>{tab.label}</button>)}
      </div>
      <button type="button" className={`kg-filter-button${panelOpen ? " open" : ""}`} onClick={() => setPanelOpen((value) => !value)} aria-expanded={panelOpen}>
        <SlidersHorizontal size={15} /> Filters {panelCount > 0 && <span className="kg-badge">{panelCount}</span>}
        <ChevronDown size={14} className="kg-chevron" />
      </button>
    </section>

    {panelOpen && <section className="kg-filter-panel" aria-label="More filters">
      <FilterSelect label="Priority" value={filters.priority} onChange={(value) => setFilter("priority", value)}
        options={Object.entries(PRIORITY_LABELS).map(([id, label]) => ({ id, label }))} />
      <FilterSelect label="Reason" value={filters.reason} onChange={(value) => setFilter("reason", value)}
        options={(config?.reasons || []).map((item) => ({ id: item.id, label: item.label }))} />
      <FilterSelect label="Language" value={filters.language} onChange={(value) => setFilter("language", value)}
        options={(summary?.facets?.languages || []).map((id) => ({ id, label: LANGUAGE_LABELS[id] || id }))} />
      <FilterSelect label="Category" value={filters.category} onChange={(value) => setFilter("category", value)}
        options={(summary?.facets?.categories || []).map((id) => ({ id, label: humanize(id) }))} />
      <button type="button" className="kg-text-button" onClick={clearAll} disabled={!anyFilter}>Reset all</button>
    </section>}

    {error && <div className="kg-notice error" role="alert"><AlertTriangle size={16} /><span>{error}</span><button type="button" className="kg-text-button" onClick={refresh}>Try again</button></div>}

    <section className="kg-list-head" aria-live="polite">
      {loading ? <span className="kg-skeleton-line" style={{ width: 110 }} /> : <span>{filteredTotal} {filteredTotal === 1 ? "gap" : "gaps"}{q ? ` matching “${q}”` : ""}</span>}
      <span className="kg-muted">Sorted by priority, then most recent</span>
    </section>

    <section className="kg-list" aria-busy={loading}>
      {loading && Array.from({ length: 4 }, (_value, index) => <GapCardSkeleton key={index} />)}
      {!loading && groups.map((group) => <GapCard key={group.id} group={group} onOpen={() => setSelectedId(group.id)} />)}
      {!loading && !error && groups.length === 0 && <EmptyState hasAny={(summary?.total || 0) > 0} filtered={anyFilter} onClear={clearAll} />}
      {loadingMore && Array.from({ length: 2 }, (_value, index) => <GapCardSkeleton key={`more-${index}`} />)}
      {!loading && nextOffset !== null && <div ref={sentinel} className="kg-sentinel">
        <button type="button" className="kg-text-button" onClick={loadMore} disabled={loadingMore}>Load more</button>
      </div>}
    </section>

    {selectedId && <React.Suspense fallback={<DrawerShell onClose={() => setSelectedId("")} />}>
      <KnowledgeGapDrawer id={selectedId} isAdmin={isAdmin && config?.canManage !== false} onClose={() => setSelectedId("")} onChanged={refresh}
        onCreateKnowledge={onCreateKnowledge} onOpenKnowledgeSource={onOpenKnowledgeSource} />
    </React.Suspense>}
  </div>;
}

// Admin recording switch. First load shows a placeholder (the state is unknown,
// so no on/off wording); the page Refresh re-checks it in the background.
function RecordingSwitch({ isAdmin, refreshKey }) {
  const [state, setState] = useState({ phase: "loading", recording: false, updatedBy: null, updatedAt: null, canManage: false, error: "" });
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);

  const load = useCallback(() => {
    const current = ++seq.current;
    setChecking(true);
    request("/api/knowledge-gaps/settings")
      .then((value) => {
        if (current !== seq.current) return;
        setState({ phase: "ready", recording: value.recording === true, updatedBy: value.updatedBy || null, updatedAt: value.updatedAt || null,
          canManage: value.canManage === true, error: "" });
      })
      .catch((value) => {
        if (current !== seq.current) return;
        setState((previous) => (previous.phase === "ready" ? { ...previous, error: "Could not re-check the setting." }
          : { phase: "unavailable", recording: false, updatedBy: null, updatedAt: null, canManage: false, error: value.message }));
      })
      .finally(() => { if (current === seq.current) setChecking(false); });
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function toggle() {
    if (state.phase !== "ready" || !isAdmin || !state.canManage || saving) return;
    const next = !state.recording;
    seq.current += 1; // a save wins over any re-check still in flight
    setSaving(true);
    setState((current) => ({ ...current, recording: next, error: "" }));
    try {
      const value = await request("/api/knowledge-gaps/settings", { method: "PUT", body: JSON.stringify({ recording: next }) });
      setState((current) => ({ ...current, recording: value.recording === true, updatedBy: value.updatedBy || null, updatedAt: value.updatedAt || null }));
    } catch (value) {
      setState((current) => ({ ...current, recording: !next, error: value.message || "Could not save. Try again." }));
    } finally { setSaving(false); setChecking(false); }
  }

  // One layout for every phase: the title and description render at once, the
  // switch stays greyed out until the stored value arrives, then slides to it.
  const loading = state.phase === "loading";
  const unavailable = state.phase === "unavailable";
  const canToggle = state.phase === "ready" && isAdmin && state.canManage && !saving;
  const status = loading ? null : unavailable ? "Unavailable" : saving ? "Saving…" : state.recording ? "On" : "Paused";
  const hint = unavailable ? "The setting could not be loaded."
    : loading || state.recording ? "Captures the questions REFAL could not answer. Changes apply within a minute."
      : "Paused: no new questions are captured. Existing gaps stay.";
  const changed = state.updatedBy ? `Changed by ${state.updatedBy.split("@")[0]} · ${relativeTime(state.updatedAt)}` : "Default setting";
  const meta = loading ? "" : unavailable ? "" : state.error || (isAdmin ? changed : `${changed} · admins only`);
  const tone = unavailable ? " unavailable" : !loading && state.recording ? " on" : "";
  return <div className={`kg-recording${tone}${saving ? " saving" : ""}`} aria-busy={loading}>
    <span className="kg-recording-icon" aria-hidden="true">{unavailable ? <AlertTriangle size={15} /> : !loading && !state.recording ? <PauseCircle size={15} /> : <Radio size={15} />}</span>
    <span className="kg-recording-text">
      <strong>Gap recording
        {status && <span className={`kg-recording-status${tone}`}>{status}</span>}
        {checking && !saving && !loading && <RefreshCcw size={11} className="kg-spin kg-recheck" aria-label="Re-checking" />}</strong>
      <small>{hint}</small>
      {unavailable ? <button type="button" className="kg-inline-link" onClick={load} disabled={checking}>{checking ? "Retrying…" : "Retry"}</button>
        : <small className={state.error ? "kg-recording-error" : "kg-recording-meta"} role={state.error ? "alert" : undefined}>{meta || "\u00a0"}</small>}
    </span>
    <button type="button" role="switch" aria-checked={!loading && state.recording} aria-label="Record knowledge gaps" className="kg-switch"
      onClick={toggle} disabled={!canToggle} title={loading ? "Loading…" : canToggle ? (state.recording ? "Pause recording" : "Start recording") : "Only administrators can change this"}>
      <span className="kg-switch-thumb" /></button>
  </div>;
}

function StatsRow({ metrics, loading }) {
  if (loading || !metrics) {
    return <section className="kg-stats" aria-label="Knowledge gap summary">
      {Array.from({ length: 4 }, (_value, index) => <div key={index} className="kg-stat"><span className="kg-skeleton-line" style={{ width: "55%" }} /><span className="kg-skeleton-block" /></div>)}
      <div className="kg-stat kg-stat-trend"><span className="kg-skeleton-line" style={{ width: "40%" }} /><span className="kg-skeleton-block tall" /></div>
    </section>;
  }
  const { line, area } = sparklinePath(metrics.trend || []);
  const trendTotal = (metrics.trend || []).reduce((sum, point) => sum + (Number(point.count) || 0), 0);
  return <section className="kg-stats" aria-label="Knowledge gap summary">
    <Stat icon={CircleDot} label="Open gaps" value={metrics.openGaps} note={`${metrics.missingKnowledge} missing · ${metrics.retrievalFailures} retrieval`} />
    <Stat icon={MessageSquare} label="Questions affected" value={metrics.questionsAffected} note={`${metrics.newThisWeek} new gap${metrics.newThisWeek === 1 ? "" : "s"} this week`} />
    <Stat icon={Flame} label="High priority" value={metrics.highPriority} tone={metrics.highPriority ? "warn" : ""} note={metrics.highPriority ? "Needs attention" : "All calm"} />
    <Stat icon={CheckCircle2} label="Resolved this month" value={metrics.resolvedThisMonth} tone="ok" note={metrics.agentIssues ? `${metrics.agentIssues} agent issue${metrics.agentIssues === 1 ? "" : "s"} open` : "Keep it up"} />
    <div className="kg-stat kg-stat-trend">
      <span className="kg-stat-label"><TrendingUp size={14} /> Last 14 days</span>
      <strong>{trendTotal} <small>questions</small></strong>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="kg-sparkline" role="img" aria-label={`${trendTotal} gap questions in the last 14 days`}>
        <path d={area} className="area" /><path d={line} className="line" />
      </svg>
    </div>
  </section>;
}

function Stat({ icon: Icon, label, value, note, tone = "" }) {
  return <div className={`kg-stat ${tone}`}>
    <span className="kg-stat-label"><Icon size={14} /> {label}</span>
    <strong>{value ?? 0}</strong>
    {note && <small>{note}</small>}
  </div>;
}

function FilterSelect({ label, value, onChange, options }) {
  return <label className="kg-select">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="all">Any</option>
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  </label>;
}

function GapCard({ group, onOpen }) {
  const example = group.examples?.at(-1)?.question;
  const closed = ["resolved", "verified", "ignored"].includes(group.status);
  return <button type="button" className={`kg-card priority-${group.priority}${closed ? " closed" : ""}`} onClick={onOpen}
    onMouseEnter={loadDrawer} onFocus={loadDrawer} aria-label={`Open gap: ${group.title}`}>
    <span className="kg-card-accent" aria-hidden="true" />
    <span className="kg-card-main">
      <span className="kg-card-tags">
        <span className={`kg-pill priority ${group.priority}`}>{PRIORITY_LABELS[group.priority] || group.priority}</span>
        <span className="kg-pill reason">{group.reasonLabel}</span>
        {group.status !== "open" && <span className={`kg-pill status ${group.status}`}>{group.statusLabel}</span>}
        {group.linkedCount > 0 && <span className="kg-pill linked"><Link2 size={11} /> {group.linkedCount} linked</span>}
      </span>
      <span className="kg-card-title">{group.title}</span>
      {example && example !== group.title && <span className="kg-card-example" dir="auto">{example}</span>}
      <span className="kg-card-meta">
        <span><MessageSquare size={13} /> {group.occurrence_count} question{group.occurrence_count === 1 ? "" : "s"}</span>
        <span><Users size={13} /> {group.distinctContacts || 1} chat{group.distinctContacts === 1 ? "" : "s"}</span>
        {(group.languages || []).length > 0 && <span><Languages size={13} /> {(group.languages || []).map((code) => LANGUAGE_SHORT[code] || code).join(" · ")}</span>}
        <span><Clock size={13} /> {relativeTime(group.last_seen_at)}</span>
        <span className="kg-card-category">{humanize(group.category)}</span>
      </span>
    </span>
    <span className="kg-card-side">
      {group.owner ? <span className="kg-avatar" title={group.owner}>{initials(group.owner)}</span> : <span className="kg-avatar empty" title="Unassigned">—</span>}
      <ChevronRight size={18} className="kg-card-chevron" />
    </span>
  </button>;
}

function GapCardSkeleton() {
  return <div className="kg-card skeleton" aria-hidden="true">
    <span className="kg-card-accent" />
    <span className="kg-card-main">
      <span className="kg-card-tags"><span className="kg-skeleton-pill" /><span className="kg-skeleton-pill wide" /></span>
      <span className="kg-skeleton-line" style={{ width: "62%", height: 14 }} />
      <span className="kg-skeleton-line" style={{ width: "40%" }} />
      <span className="kg-card-meta"><span className="kg-skeleton-line" style={{ width: 70 }} /><span className="kg-skeleton-line" style={{ width: 54 }} /><span className="kg-skeleton-line" style={{ width: 64 }} /></span>
    </span>
  </div>;
}

function EmptyState({ hasAny, filtered, onClear }) {
  if (filtered && hasAny) {
    return <div className="kg-empty">
      <span className="kg-empty-icon"><Search size={22} /></span>
      <strong>No gaps match these filters</strong>
      <p>Try a different search or status.</p>
      <button type="button" onClick={onClear}>Clear filters</button>
    </div>;
  }
  return <div className="kg-empty">
    <span className="kg-empty-icon ok"><Inbox size={22} /></span>
    <strong>No knowledge gaps yet</strong>
    <p>When REFAL can&apos;t answer a company question from approved knowledge, it shows up here, grouped with similar questions.</p>
  </div>;
}
