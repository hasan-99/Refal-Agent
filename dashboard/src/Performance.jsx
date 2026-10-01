import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CalendarClock, CalendarDays, ChevronDown, MessageCircle, RefreshCcw, Search, UsersRound } from "lucide-react";
import { aggregatePerformance, leadTemperatureStatus, workflowSignalStatus } from "../performance.js";
import "./performance.css";

const TEMPERATURE_LABELS = { hot: "Hot", warm: "Warm", cold: "Cold", unclassified: "New" };
const PERFORMANCE_CACHE_MS = 12000;
let performanceCache = null;
let performanceInFlight = null;

export default function Performance({ isAdmin = false }) {
  const [payload, setPayload] = useState(() => performanceCache?.expiresAt > Date.now() ? performanceCache.payload : null);
  const [loading, setLoading] = useState(() => !(performanceCache?.expiresAt > Date.now()));
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [credits, setCredits] = useState(null);
  const [spendMonth, setSpendMonth] = useState(() => new Date().toISOString().slice(0, 7));

  const refresh = useCallback(async (signal, { force = false } = {}) => {
    try {
      if (!force && performanceCache?.expiresAt > Date.now()) {
        setPayload(performanceCache.payload);
        setError("");
        setLoading(false);
        return;
      }
      if (!performanceInFlight || force) performanceInFlight = loadPerformancePayload(signal);
      const nextPayload = await performanceInFlight;
      performanceCache = { payload: nextPayload, expiresAt: Date.now() + PERFORMANCE_CACHE_MS };
      setPayload(nextPayload);
      setError("");
    } catch (cause) {
      if (cause.name !== "AbortError") setError(cause.message || "Could not load performance data.");
    } finally {
      performanceInFlight = null;
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (!(performanceCache?.expiresAt > Date.now())) setLoading(true);
    refresh(controller.signal, { force: refreshKey > 0 });
    const timer = setInterval(() => refresh(controller.signal, { force: true }), 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let active = true;
    const loadCredits = async () => {
      try {
        const response = await fetch("/api/openrouter/credits", { credentials: "include", cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Credits unavailable");
        if (active) setCredits(body);
      } catch {
        if (active) setCredits({ available: false, reason: "temporarily_unavailable" });
      }
    };
    loadCredits();
    const timer = setInterval(loadCredits, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [isAdmin]);

  const metrics = useMemo(() => aggregatePerformance(payload || {}), [payload]);
  const actualUsage = payload?.overview?.usageAnalytics?.actual;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const actualMonth = actualUsage?.byMonth?.find((month) => month.period === currentMonth);
  const usageMonths = actualUsage?.byMonth || [];
  const selectedSpendMonth = usageMonths.find((month) => month.period === spendMonth) || usageMonths.at(-1);
  const selectedDailySpend = selectedSpendMonth
    ? (actualUsage?.byDay || []).filter((day) => day.period.startsWith(selectedSpendMonth.period))
    : [];
  const maxDailySpend = Math.max(0, ...selectedDailySpend.map((day) => day.exactCostUsd));
  const leads = payload?.leads || [];
  const visibleLeads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return leads;
    return leads.filter((lead) => `${lead.name || ""} ${lead.phone || ""}`.toLowerCase().includes(needle));
  }, [leads, query]);

  const summary = [
    { label: "Conversations today", value: metrics.conversations.today, detail: `${metrics.conversations.messagesToday.toLocaleString()} messages today`, ratio: share(metrics.conversations.today, metrics.conversations.week), comparison: `${metrics.conversations.today} of ${metrics.conversations.week} this week`, icon: MessageCircle },
    { label: "Total leads", value: metrics.leads.total, detail: `${metrics.conversations.engagedContacts.toLocaleString()} with conversation history`, ratio: share(metrics.conversations.engagedContacts, metrics.leads.total), comparison: `${metrics.conversations.engagedContacts} engaged`, icon: UsersRound },
    { label: "Hot leads", value: metrics.leads.temperature.hot, detail: "Strong intent or appointment", ratio: share(metrics.leads.temperature.hot, metrics.leads.total), comparison: `${metrics.leads.temperature.hot} of ${metrics.leads.total} leads`, icon: Activity },
    { label: "Confirmed bookings", value: metrics.appointments.booked, detail: `${metrics.appointments.upcoming.toLocaleString()} upcoming`, ratio: share(metrics.appointments.upcoming, metrics.appointments.booked), comparison: `${metrics.appointments.upcoming} upcoming`, icon: CalendarClock }
  ];

  return <div className="page-stack performance-page">
    <section className="performance-heading">
      <div><span className="performance-eyebrow"><Activity size={14} /> WORKSPACE PERFORMANCE</span><h2>Signals that move the pipeline</h2><p>Live conversation activity, lead review, and appointment outcomes.</p></div>
      <button className="ghost performance-refresh" type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading} aria-label="Refresh performance"><RefreshCcw size={15} /> Refresh</button>
    </section>

    {error && <div className="performance-alert" role="alert"><span>{error}</span><button className="ghost" type="button" onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>}

    <section className="performance-kpis" aria-label="Performance indicators">
      {summary.map(({ label, value, detail, ratio, comparison, icon: Icon }) => <article className="performance-kpi" key={label}>
        <div className="performance-kpi-ring" style={{ "--ring-progress": `${ratio}%` }} role="meter" aria-label={`${label}: ${comparison}`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={ratio}>
          <span><strong>{loading && !payload ? "—" : value.toLocaleString()}</strong><small>{label === "Conversations today" ? "TODAY" : label === "Confirmed bookings" ? "BOOKED" : "TOTAL"}</small></span>
        </div>
        <div className="performance-kpi-copy"><span className="performance-kpi-icon"><Icon size={15} /></span><span className="performance-kpi-label">{label}</span><small>{detail}</small></div>
      </article>)}
    </section>

    <section className="performance-overview">
      <article className="performance-panel performance-activity">
        <div className="performance-panel-heading"><div><span className="performance-section-label">LEAD CONVERSION</span><h3>Contact pipeline</h3></div><MessageCircle size={18} /></div>
        <div className="performance-pipeline" aria-label="Lead pipeline counts">
          <div className="performance-pipeline-heading"><span>Counts from current lead records</span></div>
          <PipelineRow label="Leads with conversation history" value={metrics.conversations.engagedContacts} total={metrics.leads.total} />
          <PipelineRow label="Hot · strong intent" value={metrics.leads.temperature.hot} total={metrics.leads.total} />
          <PipelineRow label="Warm · interested" value={metrics.leads.temperature.warm} total={metrics.leads.total} />
          <PipelineRow label="Have a confirmed booking" value={metrics.leads.booked} total={metrics.leads.total} />
        </div>
      </article>

      <article className="performance-panel performance-workflow-panel">
        <div className="performance-panel-heading"><div><span className="performance-section-label">WORKFLOW QUEUE</span><h3>Operator attention</h3></div><Activity size={18} /></div>
        <div className="performance-workflow-grid" aria-label="Workflow classification totals">
          <WorkflowMetric label="High priority" value={metrics.leads.workflow.priority} tone="priority" />
          <WorkflowMetric label="Handover" value={metrics.leads.workflow.handovers} tone="handover" />
          <WorkflowMetric label="Complaints" value={metrics.leads.workflow.complaints} tone="complaint" />
          <WorkflowMetric label="Existing clients" value={metrics.leads.workflow.existingClients} tone="existing" />
          <WorkflowMetric label="Consent granted" value={metrics.leads.workflow.consentGranted} tone="consent" />
          <WorkflowMetric label="Consent unknown" value={metrics.leads.workflow.consentUnknown} tone="unknown" />
        </div>
        <p className="performance-table-note">Counts use operator-safe workflow metadata. Customer messages and internal reasoning are excluded.</p>
      </article>

    </section>

    <section className="performance-usage" aria-label="Model usage analytics">
      <div className="performance-usage-heading"><div><span className="performance-section-label">MODEL ACCOUNTING</span><h3>Usage and spend</h3><p>Actuals are provider-reported when available, from the latest 5,000 stored events. Earlier requests are not backfilled.</p></div>
        {isAdmin && <div className="performance-credit-balance"><span>OpenRouter credits</span><strong>{credits?.available ? formatUsd(credits.remainingCreditsUsd) : "Unavailable"}</strong><small>{credits?.available ? `Checked ${formatShortDate(credits.checkedAt)}` : credits?.reason === "management_key_required" ? "A management key is required for this balance." : credits?.reason === "not_configured" ? "No OpenRouter key configured." : "Credit balance could not be retrieved."}</small></div>}
      </div>

      <div className="performance-usage-summary">
        <article><span>Actual spend this month</span><strong>{bucketSpend(actualMonth)}</strong><small>{actualMonth?.exactCostInteractions ? `${actualMonth.exactCostInteractions} interactions with reported cost` : "No exact cost has been reported this month"}</small></article>
        <article><span>Actual tokens this month</span><strong>{Number(actualMonth?.actualTokens || 0).toLocaleString()}</strong><small>Provider-reported token totals</small></article>
        <article className="estimated"><span>Existing estimate this month</span><strong>{formatUsd(payload?.overview?.usage?.estimatedCost || 0)}</strong><small>Model-based estimate · not actual provider spend</small></article>
        <article><span>Actuals tracked</span><strong>{Number(actualUsage?.interactions || 0).toLocaleString()}</strong><small>{actualUsage?.trackedSince ? `Since ${formatShortDate(actualUsage.trackedSince)}` : "No provider usage has been recorded yet"}</small></article>
      </div>

      {actualUsage?.missingCostInteractions > 0 && <p className="performance-data-gap" role="status">Exact cost was not included for {actualUsage.missingCostInteractions.toLocaleString()} tracked interaction{actualUsage.missingCostInteractions === 1 ? "" : "s"}; those are excluded from actual spend totals.</p>}

      <div className="performance-usage-trends">
        <article className="performance-usage-chart"><div className="performance-panel-heading"><div><span className="performance-section-label">PROVIDER ACTUALS</span><h3>Daily spend</h3></div>
          <label className="performance-month-filter" title="Filter daily spend by month"><CalendarDays size={15} /><span className="visually-hidden">Filter spend by month</span><select value={selectedSpendMonth?.period || spendMonth} onChange={(event) => setSpendMonth(event.target.value)} aria-label="Filter daily spend by month">
            {usageMonths.length ? usageMonths.map((month) => <option key={month.period} value={month.period}>{formatMonth(month.period)}</option>) : <option value={spendMonth}>No usage yet</option>}
          </select><ChevronDown size={13} /></label>
        </div>
          <p className="performance-spend-period">{selectedSpendMonth ? `${formatMonth(selectedSpendMonth.period)} · ${bucketSpend(selectedSpendMonth)} actual spend` : "No monthly usage data yet"}</p>
          <div className="performance-day-bars" style={{ "--day-count": Math.max(1, selectedDailySpend.length) }} role="list" aria-label={`Daily provider-reported spend for ${selectedSpendMonth ? formatMonth(selectedSpendMonth.period) : "selected month"}`}>
            {selectedDailySpend.map((day) => <div className="performance-day-bar" role="listitem" key={day.period} title={`${day.period}: ${bucketSpend(day)} from ${day.interactions} interactions`}>
              <span>{bucketSpendCompact(day)}</span><i style={{ "--bar-scale": maxDailySpend ? Math.max(0.03, day.exactCostUsd / maxDailySpend) : 0 }} /><small>{day.period.slice(8)}</small>
            </div>)}
          </div>
          {!selectedDailySpend.length && <p className="performance-state">No daily usage recorded for this month.</p>}
        </article>

        <article className="performance-usage-insights"><div className="performance-panel-heading"><div><span className="performance-section-label">TRACKED PATTERNS</span><h3>Usage insights</h3></div></div>
          {actualUsage?.heaviestClient ? <div className="performance-insight"><span>Heaviest model user</span><strong>{actualUsage.heaviestClient.clientLabel}</strong><small>{actualUsage.heaviestClient.actualTokens.toLocaleString()} actual tokens · {actualUsage.heaviestClient.model}</small></div> : <p className="performance-state">Not enough provider-reported token data yet.</p>}
          {actualUsage?.heaviestModel && <div className="performance-insight"><span>Most-used model by actual tokens</span><strong>{actualUsage.heaviestModel.model}</strong><small>{actualUsage.heaviestModel.actualTokens.toLocaleString()} provider-reported tokens</small></div>}
          <div className="performance-subheading"><h4>Longest contact histories</h4><span>Stored message turns</span></div>
          {actualUsage?.longestContacts?.length ? <ol className="performance-longest-list">{actualUsage.longestContacts.map((contact, index) => <li key={`${contact.clientLabel}-${index}`}><span>{contact.clientLabel}</span><strong>{contact.turns.toLocaleString()}</strong></li>)}</ol> : <p className="performance-state">No conversation turns recorded yet.</p>}
        </article>
      </div>

      <article className="performance-usage-table-wrap"><div className="performance-subheading"><h4>Spend by conversation</h4><span>WhatsApp threads · top 20 by exact cost</span></div>
        {(actualUsage?.clients || []).length ? <div className="performance-table-scroll"><table className="performance-usage-table"><thead><tr><th>Client</th><th>Interactions</th><th>Reported tokens</th><th>Exact spend</th><th>Cost unavailable</th></tr></thead><tbody>{actualUsage.clients.map((client, index) => <tr key={`${client.clientLabel}-${index}`}><td>{client.clientLabel}</td><td>{client.interactions.toLocaleString()}</td><td>{client.tokenReportedInteractions ? client.actualTokens.toLocaleString() : "Unavailable"}</td><td>{client.exactCostInteractions ? formatUsd(client.exactCostUsd) : "Unavailable"}</td><td>{client.missingCostInteractions.toLocaleString()}</td></tr>)}</tbody></table></div> : <p className="performance-state">Client-level actuals will appear after usage events are recorded.</p>}
        <p className="performance-table-note">Dashboard chat usage is included in workspace totals above, but excluded from WhatsApp client totals.</p>
      </article>

      <article className="performance-usage-table-wrap"><div className="performance-subheading"><h4>Recent model interactions</h4><span>Latest 30 · message content is never logged here</span></div>
        {(actualUsage?.interactionsList || []).length ? <div className="performance-table-scroll"><table className="performance-usage-table"><thead><tr><th>Time</th><th>Client / source</th><th>Model</th><th>Prompt / completion / total tokens</th><th>Provider cost</th></tr></thead><tbody>{actualUsage.interactionsList.map((interaction, index) => <tr key={`${interaction.at}-${index}`}><td>{formatShortDate(interaction.at)}</td><td>{interaction.clientLabel}{interaction.source === "dashboard" ? " · dashboard" : ""}</td><td>{interaction.model}</td><td>{tokenValue(interaction.promptTokens)} / {tokenValue(interaction.completionTokens)} / {tokenValue(interaction.totalTokens)}</td><td>{interaction.costUsd === null ? "Unavailable" : formatUsd(interaction.costUsd)}</td></tr>)}</tbody></table></div> : <p className="performance-state">No model usage interactions have been tracked yet. Older model requests are not backfilled.</p>}
      </article>
    </section>

    <section className="performance-panel performance-leads">
      <div className="performance-leads-heading"><div><span className="performance-section-label">CONVERSATION SIGNALS</span><h3>Lead qualification</h3><p>RAFA updates temperature from expressed interest and booking activity.</p></div>
        <label className="performance-search"><Search size={15} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a lead" aria-label="Search leads" /></label>
      </div>
      <div className="performance-temperature-summary" aria-label="Lead temperature counts">
        {[
          ["hot", "Hot", metrics.leads.temperature.hot, "#d56d56"],
          ["warm", "Warm", metrics.leads.temperature.warm, "#d7a343"],
          ["cold", "Cold", metrics.leads.temperature.cold, "#5797b7"],
          ["unclassified", "New", metrics.leads.temperature.unclassified, "#8b9da6"]
        ].map(([key, label, value, color]) => <div className={`performance-temperature-stat ${key}`} key={key}>
          <div className="performance-temperature-ring" style={{ "--temperature-color": color, "--temperature-progress": `${share(value, metrics.leads.total)}%` }} role="img" aria-label={`${label}: ${value} leads`}><span>{value.toLocaleString()}</span></div>
          <span><strong>{label}</strong><small>{share(value, metrics.leads.total)}% of leads</small></span>
        </div>)}
      </div>
      {loading && !payload ? <p className="performance-state">Loading leads…</p> : visibleLeads.length ? <div className="performance-lead-list" tabIndex={0} aria-label={`Lead list, ${visibleLeads.length} leads`}>
        {visibleLeads.map((lead) => {
          const status = leadTemperatureStatus(lead);
          const workflow = workflowSignalStatus(lead);
          return <article className="performance-lead-row" key={lead.id}>
            <div className="performance-lead-person"><span className="performance-avatar">{initials(lead.name || lead.phone)}</span><span><strong>{lead.name || "Unnamed lead"}</strong><small>{lead.phone || "No phone number"}</small></span></div>
            <span className={`performance-status ${status}`}>{TEMPERATURE_LABELS[status]}</span>
            <span className="performance-workflow-inline">{workflow.intent !== "unknown" ? workflow.intent : workflow.classification}{workflow.handoverRequired ? " · handover" : ""}</span>
            <span className="performance-lead-activity">{Number(lead.conversationCount || 0).toLocaleString()} conversations</span>
            <span className="performance-read-only">{workflow.complaint ? "Complaint review" : workflow.existingClient ? "Existing-client verification" : lead.leadTemperatureReason === "appointment_booked" ? "Appointment booked" : lead.leadTemperatureReason === "appointment_interest" ? "Asked about an appointment" : lead.leadTemperatureReason === "refalco_interest" ? "Interested in Refalco" : lead.leadTemperatureReason === "explicit_decline" ? "Declined further contact" : "No clear signal yet"}</span>
          </article>;
        })}
      </div> : <p className="performance-state">{leads.length ? "No leads match this search." : "No lead records yet."}</p>}
    </section>
  </div>;
}

async function loadPerformancePayload(signal) {
  const responses = await Promise.all([
    fetch("/api/overview", { credentials: "include", cache: "no-store", signal }),
    fetch("/api/leads", { credentials: "include", cache: "no-store", signal }),
    fetch("/api/bookings", { credentials: "include", cache: "no-store", signal })
  ]);
  const bodies = await Promise.all(responses.map((response) => response.json().catch(() => ({}))));
  const failed = responses.findIndex((response) => !response.ok);
  if (failed !== -1) throw new Error(bodies[failed].error || `Could not load performance data (${responses[failed].status}).`);
  return { overview: bodies[0], leads: bodies[1].users || [], bookings: bodies[2].bookings || [] };
}

function formatUsd(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8, useGrouping: false })}` : "Unavailable";
}

function formatUsdCompact(value) {
  const amount = Number(value || 0);
  return amount >= 1 ? `$${amount.toFixed(2)}` : amount > 0 ? `$${amount.toFixed(4)}` : "$0";
}

function bucketSpend(bucket) {
  if (!bucket) return "Unavailable";
  if (!bucket.interactions) return "$0.00";
  return bucket.exactCostInteractions ? formatUsd(bucket.exactCostUsd) : "Unavailable";
}

function bucketSpendCompact(bucket) {
  if (!bucket?.interactions) return "$0";
  return bucket.exactCostInteractions ? formatUsdCompact(bucket.exactCostUsd) : "—";
}

function formatShortDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date) : "—";
}

function formatMonth(value) {
  const [year, month] = value.split("-").map(Number);
  return year && month ? new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1))) : value;
}

function share(part, whole) {
  return whole > 0 ? Math.min(100, Math.max(0, Math.round((part / whole) * 100))) : 0;
}

function tokenValue(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value.toLocaleString() : "—";
}

function PipelineRow({ label, value, total }) {
  const width = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return <div className="performance-pipeline-row"><span>{label}</span><div className="performance-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}><i style={{ "--track-scale": width / 100 }} /></div><strong>{value.toLocaleString()}</strong></div>;
}

function WorkflowMetric({ label, value, tone }) {
  return <div className={`performance-workflow-metric ${tone}`}><strong>{Number(value || 0).toLocaleString()}</strong><span>{label}</span></div>;
}

function initials(value) {
  return String(value || "L").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "L";
}
