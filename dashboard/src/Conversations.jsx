import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowDownLeft, ArrowLeft, ArrowUp, ArrowUpDown, ArrowUpRight, BadgeCheck,
  CalendarCheck2, CalendarClock, CalendarDays, Check, ChevronDown, CircleAlert, CircleDashed, Download,
  Clock3, Flame, MessageCircle, MessageCircleMore, MoreHorizontal, Pencil, RefreshCw,
  RotateCcw, Search, Send, SlidersHorizontal, Snowflake, Sun, UsersRound, X, Save, Trash2
} from "lucide-react";
import "./conversations.css";
import { requestConversationDeletion } from "./conversationActions.js";
import { fetchConversationLists, watchForConversationListChanges } from "./conversationListRefresh.js";
import { LeadTemperatureSummary } from "./leadTemperatureSummary.js";

const EMPTY = [];
export default function Conversations({ isAdmin, onNavigate, view: initialView = "inbox", onViewChange, selectedConversationId = "", onSelectedConversationChange }) {
  const [rows, setRows] = useState(EMPTY);
  const [leads, setLeads] = useState(EMPTY);
  const [view, setView] = useState(initialView);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [range, setRange] = useState("all");
  const [secondaryFilter, setSecondaryFilter] = useState("all");
  const [openFilter, setOpenFilter] = useState("");
  const filterMenuRef = useRef(null);
  const [sort, setSort] = useState({ key: "lastMessageAt", direction: "desc" });
  const [selectedId, setSelectedIdState] = useState(selectedConversationId || "");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [deletingId, setDeletingId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const listRefreshController = useRef(null);

  const loadRows = useCallback(async (signal, { quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError("");
    }
    try {
      const lists = await fetchConversationLists(fetch, signal);
      setRows(lists.rows);
      setLeads(lists.leads);
    } catch (cause) {
      if (!quiet && cause.name !== "AbortError") setError(cause.message || "Could not load conversations.");
    } finally {
      if (!quiet && !signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listRefreshController.current?.abort();
    loadRows(controller.signal);
    return () => controller.abort();
  }, [loadRows, refreshKey]);

  useEffect(() => {
    const refreshLists = () => {
      listRefreshController.current?.abort();
      const controller = new AbortController();
      listRefreshController.current = controller;
      loadRows(controller.signal, { quiet: true }).finally(() => {
        if (listRefreshController.current === controller) listRefreshController.current = null;
      });
    };
    const stopWatching = watchForConversationListChanges({ refresh: refreshLists });
    return () => {
      stopWatching();
      listRefreshController.current?.abort();
      listRefreshController.current = null;
    };
  }, [loadRows]);

  useEffect(() => setView(initialView), [initialView]);
  useEffect(() => setSelectedIdState(selectedConversationId || ""), [selectedConversationId]);

  const setSelectedId = useCallback((value) => {
    setSelectedIdState(value);
    onSelectedConversationChange?.(value);
  }, [onSelectedConversationChange]);

  useEffect(() => {
    if (!openFilter) return undefined;
    const closeOutside = (event) => {
      if (!filterMenuRef.current?.contains(event.target)) setOpenFilter("");
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpenFilter("");
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openFilter]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    fetch(`/api/conversations/${encodeURIComponent(selectedId)}`, {
      credentials: "include", cache: "no-store", signal: controller.signal
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Could not load this conversation (${response.status}).`);
      if (!Array.isArray(payload.turns)) throw new Error("The conversation service returned an invalid transcript.");
      setDetail({ user: payload.user || {}, turns: [...payload.turns].sort((a, b) => dateValue(a.at || a.createdAt) - dateValue(b.at || b.createdAt)) });
    }).catch((cause) => {
      if (cause.name !== "AbortError") setDetailError(cause.message || "Could not load this conversation.");
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [selectedId, detailRefreshKey]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const today = startOfToday();
    const cutoff = range === "today" ? today : range === "yesterday" ? today - 864e5 : range === "7d" ? now - 7 * 864e5 : range === "30d" ? now - 30 * 864e5 : range === "older" ? now - 30 * 864e5 : 0;
    const needle = query.trim().toLocaleLowerCase();
    const source = view === "leads" ? leads : rows;
    return source.filter((row) => {
      const user = row.user || row;
      const lastText = row.lastMessage || row.lastMessagePreview || row.lastMessageText || "";
      const searchable = [user.name, user.phone, user.id, row.name, row.phone, row.userId, lastText].filter(Boolean).join(" ").toLocaleLowerCase();
      if (needle && !searchable.includes(needle)) return false;
      const activityAt = dateValue(row.lastMessageAt || row.updatedAt);
      if (cutoff && activityAt < cutoff) return false;
      if (range === "yesterday" && activityAt >= today) return false;
      if (range === "older" && (!activityAt || activityAt >= cutoff)) return false;
      if (view === "leads") {
        const temperature = ["hot", "warm", "cold"].includes(row.leadTemperatureStatus) ? row.leadTemperatureStatus : "new";
        if (filter !== "all" && temperature !== filter) return false;
        const bookingStatus = String(row.bookingStatus || "none").toLowerCase();
        if (secondaryFilter === "booked" && !["booked", "confirmed"].includes(bookingStatus)) return false;
        if (secondaryFilter === "not_booked" && ["booked", "confirmed"].includes(bookingStatus)) return false;
      } else {
        if (filter === "needs_reply" && row.needsReply !== true) return false;
        if (filter === "has_replies" && row.hasAgentReply !== true) return false;
        if (filter === "customer_only" && (row.hasCustomerMessage !== true || row.hasAgentReply === true)) return false;
        const direction = String(row.lastMessageDirection || row.direction || "").toLowerCase();
        if (secondaryFilter === "customer_last" && !["incoming", "inbound", "customer"].includes(direction)) return false;
        if (secondaryFilter === "rafa_last" && !["outgoing", "outbound", "assistant", "agent", "rafa"].includes(direction)) return false;
      }
      return true;
    }).sort((a, b) => {
      const av = sortValue(a, sort.key), bv = sortValue(b, sort.key);
      const result = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.direction === "asc" ? result : -result;
    });
  }, [rows, leads, view, query, filter, range, secondaryFilter, sort]);
  const activeFilters = Number(Boolean(query.trim())) + Number(range !== "all") + Number(filter !== "all") + Number(secondaryFilter !== "all");
  const clearFilters = () => { setQuery(""); setRange("all"); setFilter("all"); setSecondaryFilter("all"); };

  const openConversation = (row) => {
    const id = row.userId || row.user?.id || row.id;
    if (!id) return;
    setSelectedId(String(id));
    setDetail(null);
    onNavigate?.("conversations", String(id));
  };

  const changeSort = (key) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === "desc" ? "asc" : "desc"
  }));

  const deleteConversation = async (row) => {
    const userId = String(row.userId || row.user?.id || row.id || "");
    const name = row.user?.name || row.user?.pushName || row.user?.phone || userId;
    if (!isAdmin || !userId || deletingId) return;
    setDeleteError("");
    setDeletingId(userId);
    try {
      const deletion = await requestConversationDeletion({ userId, displayName: name, confirmed: true });
      if (deletion.cancelled) return;
      setDeleteTarget(null);
      setRows((current) => current.filter((item) => String(item.userId || item.user?.id || item.id || "") !== userId));
      setLeads((current) => current.map((lead) => String(lead.id || "") === userId ? { ...lead, conversationCount: 0, lastMessagePreview: "", lastMessageAt: "" } : lead));
      listRefreshController.current?.abort();
      const controller = new AbortController();
      listRefreshController.current = controller;
      try {
        await loadRows(controller.signal);
      } finally {
        if (listRefreshController.current === controller) listRefreshController.current = null;
      }
    } catch (cause) {
      setDeleteError(cause.message || "Could not delete this conversation.");
    } finally {
      setDeletingId("");
    }
  };

  if (selectedId) return <ConversationDetail
    id={selectedId}
    detail={detail}
    loading={detailLoading}
    error={detailError}
    onRefresh={() => setDetailRefreshKey((key) => key + 1)}
    isAdmin={isAdmin}
    onNavigate={onNavigate}
    onBack={() => { setSelectedId(""); setDetail(null); }}
    onSaved={(turnId, savedTurn) => {
      setDetail((current) => current && ({ ...current, turns: current.turns.map((turn) => turn.id === turnId ? savedTurn : turn) }));
      setRefreshKey((key) => key + 1);
    }}
    onContactSaved={(user) => {
      setDetail((current) => current && ({ ...current, user: { ...current.user, ...user } }));
      setRows((current) => current.map((row) => String(row.userId || row.user?.id || "") === selectedId ? { ...row, user: { ...row.user, ...user } } : row));
      setLeads((current) => current.map((lead) => String(lead.id || "") === selectedId ? { ...lead, name: user.name || "", phone: user.phone || user.rawPhone || "" } : lead));
    }}
  />;

  return <section className="conversations-workspace" aria-labelledby="conversations-title">
    <header className="conversations-heading">
      <div>
        <span className="conversations-eyebrow">INBOX</span>
        <h2 id="conversations-title">Customer inbox</h2>
        <p>Customer messages and REFAL replies, in one place.</p>
      </div>
      <button className="conversations-icon-button" type="button" onClick={() => setRefreshKey((key) => key + 1)} aria-label="Refresh conversations" title="Refresh">
        <RefreshCw size={17} />
      </button>
    </header>

    <LeadTemperatureSummary leads={leads} />

    <div className="conversations-view-switch" role="tablist" aria-label="Inbox views">
      <button type="button" role="tab" aria-selected={view === "inbox"} className={view === "inbox" ? "active" : ""} onClick={() => { setView("inbox"); onViewChange?.("inbox"); setFilter("all"); setSecondaryFilter("all"); }}><MessageCircleMore size={15} /> Conversations <span>{rows.length}</span></button>
      <button type="button" role="tab" aria-selected={view === "leads"} className={view === "leads" ? "active" : ""} onClick={() => { setView("leads"); onViewChange?.("leads"); setFilter("all"); setSecondaryFilter("all"); }}><UsersRound size={15} /> Leads <span>{leads.length}</span></button>
    </div>

    <div className="conversations-toolbar">
      <label className="conversation-search">
        <Search size={17} aria-hidden="true" />
        <span className="visually-hidden">Search conversations</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "leads" ? "Search leads, number, or message" : "Search name, number, or message"} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={15} /></button>}
      </label>
      <div className="conversation-filter-group" ref={filterMenuRef}>
        <FilterDropdown id="time" label="Activity date" icon={CalendarClock} value={range} open={openFilter === "time"} onToggle={() => setOpenFilter((current) => current === "time" ? "" : "time")} onChange={setRange} options={[
          { value: "all", label: "Any time", icon: CalendarClock }, { value: "today", label: "Today", icon: CalendarDays }, { value: "yesterday", label: "Yesterday", icon: CalendarDays }, { value: "7d", label: "Last 7 days", icon: Clock3 }, { value: "30d", label: "Last 30 days", icon: Clock3 }, { value: "older", label: "Older than 30 days", icon: Clock3 }
        ]} />
        <FilterDropdown id="status" label={view === "leads" ? "Lead temperature" : "Conversation status"} icon={SlidersHorizontal} value={filter} open={openFilter === "status"} onToggle={() => setOpenFilter((current) => current === "status" ? "" : "status")} onChange={setFilter} options={view === "leads" ? [
          { value: "all", label: "All leads", icon: UsersRound }, { value: "hot", label: "Hot", icon: Flame }, { value: "warm", label: "Warm", icon: Sun }, { value: "cold", label: "Cold", icon: Snowflake }, { value: "new", label: "New", icon: CircleDashed }
        ] : [
          { value: "all", label: "All conversations", icon: MessageCircleMore }, { value: "needs_reply", label: "Waiting for REFAL", icon: CircleAlert }, { value: "has_replies", label: "REFAL replied", icon: BadgeCheck }, { value: "customer_only", label: "Customer only", icon: UsersRound }
        ]} />
        <FilterDropdown id="activity" label={view === "leads" ? "Booking status" : "Last message from"} icon={view === "leads" ? CalendarCheck2 : ArrowUpDown} value={secondaryFilter} open={openFilter === "activity"} onToggle={() => setOpenFilter((current) => current === "activity" ? "" : "activity")} onChange={setSecondaryFilter} options={view === "leads" ? [
          { value: "all", label: "Any booking status", icon: CalendarDays }, { value: "booked", label: "Booked", icon: CalendarCheck2 }, { value: "not_booked", label: "Not booked", icon: CalendarClock }
        ] : [
          { value: "all", label: "Any sender", icon: ArrowUpDown }, { value: "customer_last", label: "Customer last", icon: ArrowDownLeft }, { value: "rafa_last", label: "REFAL last", icon: ArrowUpRight }
        ]} />
      </div>
      {activeFilters > 0 && <button type="button" className="conversation-clear-filters" onClick={clearFilters} aria-label={`Clear ${activeFilters} active filters`} title="Clear filters"><RotateCcw size={14} /><span>{activeFilters}</span></button>}
    </div>

    {error && <div className="conversation-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Try again</button></div>}
    {deleteError && <div className="conversation-alert" role="alert"><span>{deleteError}</span><button type="button" onClick={() => setDeleteError("")}>Dismiss</button></div>}
    {deleteTarget && <div className="conversation-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deletingId) setDeleteTarget(null); }}>
      <section className="conversation-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-delete-title" aria-describedby="conversation-delete-description">
        <span className="conversation-delete-dialog-icon"><Trash2 size={19} /></span>
        <h2 id="conversation-delete-title">Reset conversation?</h2>
        <p className="conversation-delete-dialog-contact">{deleteTarget.user?.name || deleteTarget.user?.pushName || deleteTarget.user?.phone || deleteTarget.userId || deleteTarget.id}</p>
        <p id="conversation-delete-description">This permanently removes the messages, REFAL's replies, and conversation-derived memory. The next message starts a fresh conversation. The contact record, appointments, handovers, complaints, audit records, and contact restrictions remain. This cannot be undone.</p>
        <div className="conversation-delete-dialog-actions">
          <button type="button" className="conversation-subtle-button" onClick={() => setDeleteTarget(null)} disabled={Boolean(deletingId)}>Cancel</button>
          <button type="button" className="conversation-delete-confirm-button" onClick={() => deleteConversation(deleteTarget)} disabled={Boolean(deletingId)}>{deletingId ? <><span className="conversation-spinner small" /> Resetting…</> : <><Trash2 size={14} /> Reset conversation</>}</button>
        </div>
      </section>
    </div>}
    <div className="conversation-table-shell">
      <div className="conversation-table-scroll">
        <table className="conversation-table">
          <thead><tr>{view === "leads" ? <>
            <th><SortButton label="Lead" column="contact" sort={sort} onClick={changeSort} /></th>
            <th><SortButton label="Conversations" column="conversationCount" sort={sort} onClick={changeSort} /></th>
            <th><SortButton label="Temperature" column="temperature" sort={sort} onClick={changeSort} /></th>
            <th><SortButton label="Last activity" column="lastMessageAt" sort={sort} onClick={changeSort} /></th>
            <th>Latest message</th><th><span className="visually-hidden">Open conversation</span></th>
          </> : <>
            <th><SortButton label="Contact" column="contact" sort={sort} onClick={changeSort} /></th>
            <th>WhatsApp number</th>
            <th><SortButton label="Last message" column="lastMessage" sort={sort} onClick={changeSort} /></th>
            <th><SortButton label="Direction" column="direction" sort={sort} onClick={changeSort} /></th>
            <th><SortButton label="Reply status" column="status" sort={sort} onClick={changeSort} /></th>
            <th><SortButton label="Updated" column="lastMessageAt" sort={sort} onClick={changeSort} /></th>
            <th><span className="visually-hidden">Open conversation</span></th>
          </>}</tr></thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={view === "leads" ? 6 : 7}><div className="conversation-loading"><span className="conversation-spinner" />Loading conversations</div></td></tr>}
            {!loading && !error && filtered.length === 0 && <tr><td colSpan={view === "leads" ? 6 : 7}><div className="conversation-empty"><span className="conversation-empty-icon"><MessageCircle size={20} /></span><strong>{(view === "leads" ? leads.length : rows.length) ? `No matching ${view === "leads" ? "leads" : "conversations"}` : `No ${view === "leads" ? "leads" : "conversations"} yet`}</strong><span>{(view === "leads" ? leads.length : rows.length) ? "Try another search or filter." : "Records will appear here when the service has data."}</span></div></td></tr>}
            {view === "leads" ? filtered.map((lead, index) => <LeadContactRow key={lead.id || index} lead={lead} onOpen={() => openConversation(lead)} />) : filtered.map((row, index) => <ConversationRow key={row.userId || row.user?.id || row.id || index} row={row} isAdmin={isAdmin} deleting={deletingId === String(row.userId || row.user?.id || row.id || "")} onOpen={() => openConversation(row)} onDelete={() => setDeleteTarget(row)} />)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}

function FilterDropdown({ id, label, icon: Icon, value, open, onToggle, onChange, options }) {
  const selected = options.find((option) => option.value === value) || options[0];
  const SelectedIcon = selected.icon || Icon;
  const active = value !== options[0].value;
  return <div className={`conversation-filter conversation-filter-${id}${active ? " is-active" : ""}${open ? " is-open" : ""}`}>
    <button className="conversation-filter-trigger" type="button" aria-label={`${label}: ${selected.label}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`conversation-filter-${id}`} onClick={onToggle}>
      <SelectedIcon size={15} aria-hidden="true" /><span>{selected.label}</span><ChevronDown className="conversation-filter-chevron" size={14} aria-hidden="true" />
    </button>
    {open && <div className="conversation-filter-menu" id={`conversation-filter-${id}`} role="listbox" aria-label={label}>
      {options.map((option) => { const OptionIcon = option.icon || Icon; return <button className="conversation-filter-option" type="button" role="option" aria-selected={option.value === value} key={option.value} onClick={() => { onChange(option.value); onToggle(); }}>
        <OptionIcon size={15} aria-hidden="true" /><span>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true" />}
      </button>; })}
    </div>}
  </div>;
}

function SortButton({ label, column, sort, onClick }) {
  const active = sort.key === column;
  const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return <button className={`conversation-sort${active ? " is-active" : ""}`} type="button" onClick={() => onClick(column)} aria-label={`Sort by ${label}${active ? `, ${sort.direction === "asc" ? "ascending" : "descending"}` : ""}`}>
    {label}<Icon size={13} aria-hidden="true" />
  </button>;
}

function ConversationRow({ row, isAdmin, deleting, onOpen, onDelete }) {
  const user = row.user || {};
  const phone = user.phoneOverride || user.phone || user.rawPhone || row.phone || "Number hidden by WhatsApp";
  const name = user.nameOverride || user.name || user.pushName || user.whatsappName || phone || "Unknown contact";
  const message = row.lastMessage || row.lastMessageText || "No message preview";
  const direction = row.lastMessageDirection || row.direction || "unknown";
  const status = row.needsReply ? "needs reply" : row.hasAgentReply ? "answered" : "no reply";
  const when = row.lastMessageAt || row.updatedAt;
  return <tr className="conversation-row" onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} tabIndex="0" aria-label={`Open conversation with ${name}`}>
    <td data-label="Contact"><div className="conversation-contact"><span className="conversation-avatar">{initials(name)}</span><span className="conversation-contact-copy"><strong>{name}</strong><WorkflowBadges workflow={row.user?.workflow} /></span></div></td>
    <td data-label="WhatsApp number"><span className={`conversation-whatsapp-number${phone.includes("hidden by WhatsApp") ? " is-hidden" : ""}`}>{phone}</span></td>
    <td data-label="Last message"><span className="conversation-preview" title={message}>{message}</span></td>
    <td data-label="Direction"><span className={`conversation-direction ${directionClass(direction)}`}>{directionLabel(direction)}</span></td>
    <td data-label="Reply status"><span className={`conversation-status ${statusClass(status, row.needsReply)}`}>{statusLabel(status)}</span></td>
    <td data-label="Updated"><time className="conversation-time" dateTime={when || undefined}>{formatDate(when)}</time></td>
    <td className="conversation-row-action"><span className="conversation-row-actions">
      {isAdmin && <button type="button" className="conversation-delete-button" disabled={deleting} aria-label={`Reset ${name} conversation`} title="Reset conversation" onClick={(event) => { event.stopPropagation(); onDelete(); }}>{deleting ? <span className="conversation-spinner" aria-label="Resetting" /> : <Trash2 size={15} />}</button>}
      <button type="button" className="conversation-open-button" aria-label={`Open ${name} conversation`} onClick={(event) => { event.stopPropagation(); onOpen(); }}><MoreHorizontal size={16} /></button>
    </span></td>
  </tr>;
}

function LeadContactRow({ lead, onOpen }) {
  const status = ["hot", "warm", "cold"].includes(lead.leadTemperatureStatus) ? lead.leadTemperatureStatus : "new";
  const name = lead.name || lead.phone || "Unknown lead";
  return <tr className="conversation-row lead-contact-row" onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} tabIndex="0" aria-label={`Open conversation with ${name}`}>
    <td data-label="Lead"><div className="conversation-contact"><span className="conversation-avatar">{initials(name)}</span><span className="conversation-contact-copy"><strong>{lead.name || "Unnamed lead"}</strong><small>{lead.phone || lead.id}</small><WorkflowBadges workflow={lead.workflow} /></span></div></td>
    <td data-label="Conversations"><span className="lead-turn-count">{Number(lead.conversationCount || 0).toLocaleString()}</span></td>
    <td data-label="Temperature"><span className={`conversation-temperature ${status}`}>{status === "new" ? "New" : status[0].toUpperCase() + status.slice(1)}</span></td>
    <td data-label="Last activity"><time className="conversation-time">{formatDate(lead.lastMessageAt)}</time></td>
    <td data-label="Latest message"><span className="conversation-preview" title={lead.lastMessagePreview || "No message yet"}>{lead.lastMessagePreview || "No message yet"}</span></td>
    <td className="conversation-row-action"><button type="button" className="conversation-open-button" aria-label={`Open ${name} conversation`} onClick={(event) => { event.stopPropagation(); onOpen(); }}><MoreHorizontal size={16} /></button></td>
  </tr>;
}

function ConversationDetail({ id, detail, loading, error, isAdmin, onBack, onRefresh, onSaved, onNavigate, onContactSaved }) {
  const threadRef = useRef(null);
  const [editingContact, setEditingContact] = useState(false);
  const [contactDraft, setContactDraft] = useState({ nameOverride: "", phoneOverride: "" });
  const [contactSaving, setContactSaving] = useState(false);
  const [contactNotice, setContactNotice] = useState("");
  const attachments = (detail?.turns || []).flatMap((turn) => turn.attachment && typeof turn.attachment === "object"
    ? [{ ...turn.attachment, turnAt: turn.at, turnId: turn.turnId || turn.id }]
    : []);
  const contactName = detail?.user?.name || detail?.user?.pushName || detail?.user?.phone || id;
  const contactPhone = detail?.user?.phone || "WhatsApp conversation";

  useEffect(() => {
    setContactDraft({ nameOverride: detail?.user?.nameOverride || "", phoneOverride: detail?.user?.phoneOverride || "" });
  }, [detail?.user?.nameOverride, detail?.user?.phoneOverride]);

  useEffect(() => {
    if (!detail || loading) return undefined;
    const frame = requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [detail, loading]);

  const saveContact = async (event) => {
    event.preventDefault();
    if (contactSaving) return;
    setContactSaving(true);
    setContactNotice("");
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(id)}/contact`, {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contactDraft)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save contact details.");
      onContactSaved?.(payload.user);
      setEditingContact(false);
      setContactNotice("Contact details saved.");
    } catch (cause) {
      setContactNotice(cause.message || "Could not save contact details.");
    } finally {
      setContactSaving(false);
    }
  };

  return <section className="conversations-workspace conversation-detail" aria-labelledby="conversation-detail-title">
    <header className="conversation-detail-header">
      <div className="conversation-detail-nav">
        <button type="button" className="conversation-back" onClick={onBack}><ArrowLeft size={16} /> <span>All conversations</span></button>
        <button type="button" className="conversation-refresh-button" onClick={onRefresh} disabled={loading} aria-label="Refresh conversation messages" title="Refresh messages"><RefreshCw size={16} className={loading ? "is-spinning" : ""} /></button>
      </div>
      {detail && <div className="conversation-detail-person-actions">
        {isAdmin && <button className="conversation-contact-edit-button" type="button" onClick={() => { setEditingContact((current) => !current); setContactNotice(""); }} aria-label={editingContact ? "Close contact editor" : "Edit contact details"}>{editingContact ? <X size={15} /> : <Pencil size={15} />}<span>{editingContact ? "Close" : "Edit contact"}</span></button>}
        <div className="conversation-person-heading">
          <div>
            <h1 id="conversation-detail-title">{contactName}</h1>
            <p>{contactPhone}</p>
          </div>
          <span className="conversation-avatar large">{initials(contactName)}</span>
        </div>
      </div>}
    </header>
    {editingContact && detail && <form className="conversation-contact-editor" onSubmit={saveContact}>
      <label>Correct name<input value={contactDraft.nameOverride} onChange={(event) => setContactDraft((current) => ({ ...current, nameOverride: event.target.value }))} placeholder={detail.user?.name || "Name from WhatsApp"} /></label>
      <label>Correct WhatsApp number<input value={contactDraft.phoneOverride} onChange={(event) => setContactDraft((current) => ({ ...current, phoneOverride: event.target.value }))} placeholder={detail.user?.phone || "+357..."} /></label>
      <button className="conversation-save-button" type="submit" disabled={contactSaving}>{contactSaving ? "Saving" : <><Save size={14} /> Save contact</>}</button>
    </form>}
    {contactNotice && <p className="conversation-contact-notice" role="status">{contactNotice}</p>}
    {detail && <WorkflowSummary workflow={detail.user?.workflow} isAdmin={isAdmin} />}
    {detail && <ConversationAttachments attachments={attachments} userId={id} />}
    {loading && <div className="conversation-detail-state"><span className="conversation-spinner" />Loading conversation</div>}
    {error && <div className="conversation-alert" role="alert"><span>{error}</span><button type="button" onClick={onBack}>Back to inbox</button></div>}
    {detail && !loading && <div className="conversation-thread-wrap">
      <div ref={threadRef} className="conversation-thread" aria-label="Conversation messages">
        {detail.turns.length === 0 ? <div className="conversation-empty"><strong>No messages in this conversation</strong><span>The transcript is currently empty.</span></div> : detail.turns.map((turn, index) => <MessageTurn key={turn.id || `${turn.at || turn.createdAt || "turn"}-${index}`} turn={turn} userId={id} isAdmin={isAdmin} onNavigate={onNavigate} onSaved={onSaved} />)}
      </div>
      <footer className="conversation-thread-footer"><span><MessageCircle size={15} /> Transcript</span><span>{detail.turns.length} {detail.turns.length === 1 ? "message" : "messages"}</span></footer>
    </div>}
  </section>;
}

function ConversationAttachments({ attachments, userId }) {
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState({ attachmentId: "", url: "", loading: false, error: false });
  useEffect(() => {
    if (!selected) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);
  useEffect(() => {
    if (!selected) { setPreview({ attachmentId: "", url: "", loading: false, error: false }); return undefined; }
    const existingUrl = safeAttachmentUrl(selected.previewUrl || selected.url || selected.signedUrl);
    if (existingUrl) { setPreview({ attachmentId: selected.id || "", url: existingUrl, loading: false, error: false }); return undefined; }
    if (!selected.id || !userId) { setPreview({ attachmentId: selected.id || "", url: "", loading: false, error: true }); return undefined; }
    let active = true;
    const attachmentId = selected.id;
    setPreview({ attachmentId, url: "", loading: true, error: false });
    fetch(`/api/conversations/${encodeURIComponent(userId)}/attachments/${encodeURIComponent(attachmentId)}/preview`, { credentials: "include" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || typeof body.url !== "string") throw new Error("Preview unavailable");
        const url = safeAttachmentUrl(body.url);
        if (!url) throw new Error("Preview unavailable");
        if (active) setPreview({ attachmentId, url, loading: false, error: false });
      })
      .catch(() => { if (active) setPreview({ attachmentId, url: "", loading: false, error: true }); });
    return () => { active = false; };
  }, [selected, userId]);
  if (!attachments.length) return null;
  const previewUrl = safeAttachmentUrl(selected?.previewUrl || selected?.url || selected?.signedUrl)
    || (preview.attachmentId === selected?.id ? preview.url : "");
  const contentType = String(selected?.contentType || "").toLowerCase();
  const isImage = contentType.startsWith("image/");
  const isPdf = contentType === "application/pdf" || String(selected?.fileName || "").toLowerCase().endsWith(".pdf");
  const orderedAttachments = attachments.map((attachment, index) => ({ attachment, index }))
    .sort((a, b) => dateValue(b.attachment.turnAt) - dateValue(a.attachment.turnAt) || b.index - a.index)
    .map(({ attachment }) => attachment);
  const visibleAttachments = expanded ? orderedAttachments : orderedAttachments.slice(0, 1);
  return <>
    <section className="conversation-attachments" aria-labelledby="conversation-attachments-title">
      <div className="conversation-attachments-heading">
        <div><span className="conversation-section-label">SHARED FILES</span><h2 id="conversation-attachments-title">Attachments</h2></div>
        <div className="conversation-attachments-actions">
          <span>{attachments.length} {attachments.length === 1 ? "file" : "files"}</span>
          {attachments.length > 1 && <button type="button" className="conversation-attachments-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show latest only" : `Show all ${attachments.length}`}
          </button>}
        </div>
      </div>
      <div className={`conversation-attachments-grid${expanded ? " is-expanded" : " is-compact"}`}>
        {visibleAttachments.map((attachment, index) => {
        const name = attachment.fileName || attachment.filename || "Attachment";
        const type = String(attachment.contentType || "File");
        const image = type.startsWith("image/");
        const key = attachment.id || `${attachment.turnId || "turn"}-${name}-${index}`;
        return <button className="conversation-file-card" type="button" key={key} onClick={() => setSelected(attachment)} aria-label={`Preview ${name}`}>
          <span className="conversation-file-thumb">{image && safeAttachmentUrl(attachment.previewUrl || attachment.url || attachment.signedUrl) ? <img src={safeAttachmentUrl(attachment.previewUrl || attachment.url || attachment.signedUrl)} alt="" /> : <span className="conversation-attachment-icon">{image ? "IMG" : name.split(".").pop().slice(0, 4).toUpperCase()}</span>}</span>
          <span className="conversation-file-copy"><strong title={name}>{name}</strong><small>{type}{Number.isFinite(Number(attachment.sizeBytes)) ? ` · ${formatAttachmentSize(attachment.sizeBytes)}` : ""}</small><small>{formatDate(attachment.turnAt)}</small></span>
          <span className="conversation-file-open">Preview</span>
        </button>;
      })}</div>
    </section>
    {selected && <div className="conversation-file-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className="conversation-file-modal" role="dialog" aria-modal="true" aria-labelledby="conversation-file-modal-title">
        <header><div><span className="conversation-section-label">ATTACHMENT</span><h2 id="conversation-file-modal-title">{selected.fileName || selected.filename || "Attachment"}</h2></div><button type="button" onClick={() => setSelected(null)} aria-label="Close preview"><X size={18} /></button></header>
        <div className="conversation-file-preview">{preview.loading ? <div className="conversation-file-loading" role="status">Loading secure preview…</div> : previewUrl && isImage ? <img src={previewUrl} alt={selected.fileName || "Shared image"} /> : previewUrl && isPdf ? <iframe title={`Preview ${selected.fileName || "PDF"}`} src={previewUrl} /> : <div className="conversation-file-unavailable"><span className="conversation-attachment-icon">{isImage ? "IMG" : String(selected.fileName || "FILE").split(".").pop().slice(0, 4).toUpperCase()}</span><strong>{previewUrl ? "This file type opens in a new tab." : preview.error ? "Secure preview unavailable" : "Preparing secure preview"}</strong><p>{previewUrl ? "Use the temporary secure link to view or download this attachment." : preview.error ? "The file is still private. Refresh the conversation and try again." : "A short-lived private link is being prepared."}</p></div>}</div>
        <footer><span>{selected.contentType || "File"}{Number.isFinite(Number(selected.sizeBytes)) ? ` · ${formatAttachmentSize(selected.sizeBytes)}` : ""}</span>{previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" download><Download size={14} /> Open file</a>}</footer>
      </section>
    </div>}
  </>;
}

function safeAttachmentUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function WorkflowBadges({ workflow }) {
  if (!workflow) return null;
  const flags = [workflow.closeReadiness?.status === "ready_to_proceed" && "Ready to proceed", workflow.flags?.complaint && "Complaint", workflow.flags?.existingClient && "Existing client", workflow.handover?.required && "Handover", ["high", "urgent"].includes(workflow.priority) && `${statusLabel(workflow.priority)} priority`].filter(Boolean);
  return <span className="conversation-workflow-badges" aria-label="Workflow signals">{flags.slice(0, 3).map((flag) => <span className="conversation-workflow-badge" key={flag}>{flag}</span>)}</span>;
}

function WorkflowSummary({ workflow, isAdmin }) {
  if (!workflow) return null;
  const dimensions = workflow.dimensions || {};
  return <aside className="conversation-workflow-summary" aria-label="Operator workflow summary">
    <div className="conversation-workflow-heading"><div><span className="conversation-section-label">OPERATOR SIGNALS</span><strong>{workflow.intent || "unknown"}</strong></div><span className={`conversation-priority ${workflow.priority || "normal"}`}>{statusLabel(workflow.priority || "normal")}</span></div>
    <div className="conversation-workflow-grid"><span><small>Classification</small><strong>{workflow.classification || "Unclassified"}</strong></span><span><small>Follow-up consent</small><strong>{statusLabel(workflow.consent?.followUp || "unknown")}</strong></span><span><small>Follow-up</small><strong>{statusLabel(workflow.followUp?.status || "consent required")}</strong></span><span><small>Handover</small><strong>{workflow.handover?.required ? workflow.handover.department || "Required" : "Not required"}</strong></span></div>
    {workflow.closeReadiness?.status === "ready_to_proceed" && <div className="conversation-close-ready" role="status"><strong>Ready to proceed</strong><span>Clear start intent, a defined need, and service fit were found in the customer’s messages. Review the transcript before arranging follow-up; no response time is promised.</span></div>}
    <div className="conversation-dimension-list" aria-label="Six qualification dimensions">{["need", "value", "timing", "authority", "readiness", "fit"].map((key) => <span key={key}><small>{key}</small><b>{dimensions[key] ?? "—"}/5</b></span>)}</div>
    {(workflow.flags?.complaint || workflow.flags?.existingClient) && <div className="conversation-flag-list">{workflow.flags.complaint && <span>Complaint review</span>}{workflow.flags.existingClient && <span>Existing-client verification</span>}</div>}
    {isAdmin && workflow.handover?.summary && <p className="conversation-handover-summary"><strong>Handover summary</strong>{workflow.handover.summary}</p>}
  </aside>;
}

function MessageTurn({ turn, userId, isAdmin, onNavigate, onSaved }) {
  const isAgent = ["assistant", "agent", "rafa", "bot"].includes(String(turn.role || turn.sender || turn.direction || "").toLowerCase());
  const body = turn.text || turn.content || turn.message || "";
  const attachment = !isAgent && turn.attachment && typeof turn.attachment === "object" ? turn.attachment : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const canPlatformEdit = turn.editability?.canEditOnWhatsApp === true || turn.delivery?.canEditOnWhatsApp === true;
  const canSendCorrection = turn.editability?.canSendCorrection !== false;
  const canSaveLocally = turn.editability?.canSaveLocally !== false;
  const mode = canPlatformEdit ? "platform_edit" : canSendCorrection ? "correction_resend" : "local_update";

  useEffect(() => { setDraft(body); }, [body]);

  const save = async () => {
    if (!draft.trim() || draft.trim() === body || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(userId)}/turns/${encodeURIComponent(turn.id)}/edit`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft.trim(), mode })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Could not save this change (${response.status}).`);
      const saved = payload.turn;
      if (!saved) throw new Error("The service did not return the saved message.");
      onSaved(turn.id, saved);
      setEditing(false);
      setNotice({ kind: "success", text: deliveryMessage(payload.delivery, canPlatformEdit) });
    } catch (cause) {
      setNotice({ kind: "error", text: cause.message || "Could not save this change." });
    } finally {
      setSaving(false);
    }
  };

  return <article className={`conversation-message ${isAgent ? "from-rafa" : "from-client"}`} aria-label={isAgent ? "REFAL reply" : "Customer message"}>
    <div className="conversation-message-bubble">{editing ? <div className="conversation-edit-form">
      <textarea dir="auto" aria-label="Edit REFAL reply" value={draft} maxLength={3900} onChange={(event) => setDraft(event.target.value)} rows={Math.min(8, Math.max(3, draft.split("\n").length + 1))} autoFocus />
      <div className="conversation-edit-note">{canPlatformEdit ? "WhatsApp edit is available for this message." : canSendCorrection ? "The edit window has passed or the original message key is unavailable. Saving sends a correction; the original remains unchanged." : "WhatsApp delivery is not available from this dashboard process. Saving updates the dashboard transcript only."}</div>
      <div className="conversation-edit-actions"><button type="button" className="conversation-subtle-button" onClick={() => { setEditing(false); setDraft(body); setNotice(null); }} disabled={saving}>Cancel</button>{!canPlatformEdit && !canSendCorrection && <button type="button" className="conversation-subtle-button" onClick={() => onNavigate?.("agent-status")}>Connection status</button>}<button type="button" className="conversation-save-button" onClick={save} disabled={saving || !draft.trim() || draft.trim() === body || (!canPlatformEdit && !canSendCorrection && !canSaveLocally)}>{saving ? <span className="conversation-spinner small" /> : <Send size={14} />}{saving ? "Saving" : canPlatformEdit ? "Save edit" : canSendCorrection ? "Send correction" : "Save in dashboard"}</button></div>
    </div> : <><p className="conversation-message-body" dir="auto">{body || "(Empty message)"}</p>{attachment && <div className="conversation-attachment" aria-label="Customer attachment"><span className="conversation-attachment-icon">{String(attachment.contentType || "").startsWith("image/") ? "IMG" : String(attachment.fileName || "FILE").split(".").pop().slice(0, 4).toUpperCase()}</span><span className="conversation-attachment-details"><strong>{attachment.fileName || "Attachment"}</strong><small>{attachment.contentType || "File"}{Number.isFinite(Number(attachment.sizeBytes)) ? ` · ${formatAttachmentSize(attachment.sizeBytes)}` : ""}</small></span>{attachment.status && <span className="conversation-attachment-status">{attachment.status === "uploaded" ? "Received" : attachment.status}</span>}</div>}</>}</div>
    <div className="conversation-message-footer"><time dateTime={turn.at || turn.createdAt || undefined}>{formatDate(turn.at || turn.createdAt, true)}</time>
      {isAgent && turn.responseType && <span className="conversation-response-type" aria-label={`Response type: ${turn.responseType}`}>Response type · {turn.responseType.replaceAll("_", " ")}</span>}
      {isAgent && isAdmin && !editing && <button type="button" className="conversation-edit-button" onClick={() => { setNotice(null); setEditing(true); }} aria-label="Edit REFAL reply"><Pencil size={12} /> Edit</button>}
    </div>
    {notice && <div className={`conversation-delivery-note ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "success" && <Check size={14} />}{notice.text}</div>}
  </article>;
}

function formatAttachmentSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function deliveryMessage(delivery, wasEditable) {
  if (delivery?.status === "failed") return delivery.message || "Saved locally, but WhatsApp delivery failed.";
  if (delivery?.action === "local_update" || delivery?.dashboardOnly === true) return "Saved in the dashboard transcript. WhatsApp was not changed.";
  if (delivery?.action === "platform_edit" || delivery?.edited === true) return "The message edit was accepted by WhatsApp.";
  if (delivery?.action === "correction_resend" || delivery?.resent === true) return "Correction sent as a new WhatsApp message. The original message remains unchanged.";
  return wasEditable ? "Change saved. Delivery status is pending confirmation." : "Correction queued as a new message. The original remains unchanged.";
}

function sortValue(row, key) {
  if (key === "contact") return row.user?.nameOverride || row.user?.name || row.user?.pushName || row.user?.whatsappName || row.user?.phone || row.user?.rawPhone || row.phone || "";
  if (key === "conversationCount") return Number(row.conversationCount || 0);
  if (key === "temperature") return row.leadTemperatureStatus || "new";
  if (key === "lastMessage") return row.lastMessage || row.lastMessagePreview || row.lastMessageText || "";
  if (key === "direction") return row.lastMessageDirection || row.direction || "";
  if (key === "status") return row.needsReply === true ? "needs reply" : row.hasAgentReply ? "answered" : "no reply";
  return dateValue(row.lastMessageAt || row.updatedAt);
}

function dateValue(value) { const parsed = value ? new Date(value).getTime() : 0; return Number.isFinite(parsed) ? parsed : 0; }
function startOfToday() { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); }
function initials(value) { const parts = String(value || "?").trim().split(/\s+/).filter(Boolean); return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "?").toLocaleUpperCase(); }
function directionClass(value) { const dir = String(value).toLowerCase(); return ["inbound", "incoming", "customer"].includes(dir) ? "incoming" : ["outbound", "outgoing", "assistant", "agent"].includes(dir) ? "outgoing" : "unknown"; }
function directionLabel(value) { const dir = String(value || "").toLowerCase(); if (["inbound", "incoming", "customer"].includes(dir)) return "Incoming"; if (["outbound", "outgoing", "assistant", "agent"].includes(dir)) return "Outgoing"; return "Unknown"; }
function statusClass(value, needsReply) { if (needsReply) return "needs-reply"; return String(value).toLowerCase() === "answered" ? "active" : "unknown"; }
function statusLabel(value) { const status = String(value || "").replaceAll("_", " "); return status ? status[0].toUpperCase() + status.slice(1) : "Unknown"; }
function formatDate(value, full = false) {
  if (!value || !dateValue(value)) return "Date unavailable";
  const date = new Date(value);
  const options = full ? { dateStyle: "medium", timeStyle: "short" } : date.toDateString() === new Date().toDateString() ? { timeStyle: "short" } : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}
