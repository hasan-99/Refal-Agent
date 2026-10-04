import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Bell, Check, Mail, MessageCircle, RefreshCcw, Save, Send } from "lucide-react";
import { groupHandoversByContact } from "../handoverGrouping.js";
import "./handover-inbox.css";

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function dateLabel(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Time unavailable";
}

export default function HandoverInbox({ onNavigate }) {
  const [handovers, setHandovers] = useState([]);
  const [notificationSchemaReady, setNotificationSchemaReady] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await request("/api/handovers");
      const groupedHandovers = groupHandoversByContact(result.handovers);
      setHandovers(groupedHandovers);
      setNotificationSchemaReady(result.notificationSchemaReady !== false);
      setSelectedId((current) => groupedHandovers.some((item) => item.groupKey === current) ? current : groupedHandovers[0]?.groupKey || "");
    } catch (cause) { setError(cause.message || "Could not load specialist requests."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = setInterval(load, 20000); return () => clearInterval(timer); }, [load]);

  const selected = useMemo(() => handovers.find((item) => item.groupKey === selectedId) || null, [handovers, selectedId]);
  const drafts = selected?.drafts || [];

  useEffect(() => {
    if (!selected) return;
    const defaultChannel = selected.contact?.email ? "email" : "whatsapp";
    setChannel(defaultChannel);
    setRecipient(defaultChannel === "email" ? selected.contact.email : selected.contact?.whatsappJid || "");
    setSubject("");
    setText("");
    setNotice("");
  }, [selectedId]);

  async function updateStatus(status) {
    if (!selected || busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await request(`/api/handovers/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: JSON.stringify({ status }) }); setNotice(status === "resolved" ? "Specialist request marked resolved." : "Specialist request acknowledged."); await load(); }
    catch (cause) { setError(cause.message || "Could not update the request."); }
    finally { setBusy(false); }
  }

  async function saveDraft(event) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/handovers/${encodeURIComponent(selected.id)}/follow-ups`, { method: "POST", body: JSON.stringify({ channel, recipient, subject, text }) });
      setNotice("Draft saved. It has not been sent; approve it below when ready.");
      setSubject(""); setText(""); await load();
    } catch (cause) { setError(cause.message || "Could not save this draft."); }
    finally { setBusy(false); }
  }

  async function approveDraft(draft) {
    if (busy || draft.status !== "draft") return;
    setBusy(true); setError(""); setNotice("");
    try { await request(`/api/notifications/${encodeURIComponent(draft.id)}/send`, { method: "POST", body: JSON.stringify({}) }); setNotice("Approved and queued. Delivery status will update here."); await load(); }
    catch (cause) { setError(cause.message || "Could not queue the approved message."); }
    finally { setBusy(false); }
  }

  return <div className="page-stack handover-page">
    <section className="handover-hero">
      <div><span className="handover-kicker"><Bell size={14} /> ADMIN WORKFLOW</span><h2>Specialist follow-ups</h2><p>Review consented handovers, prepare WhatsApp or email drafts, then explicitly approve delivery.</p></div>
      <button className="ghost handover-refresh" type="button" onClick={() => void load()} disabled={loading}><RefreshCcw size={15} /> Refresh</button>
    </section>
    {error && <div className="handover-alert" role="alert">{error}</div>}
    {notice && <div className="handover-notice" role="status">{notice}</div>}
    {!notificationSchemaReady && <div className="handover-alert" role="status">Handover records can be reviewed, but drafts and delivery tracking are not enabled in Supabase yet. Apply the latest handover-follow-ups migration and deploy the matching agent API before composing messages.</div>}
    <div className="handover-layout">
      <section className="handover-list panel" aria-label="Open specialist requests">
        <div className="handover-list-head"><div><span className="handover-eyebrow">OPEN QUEUE</span><h3>Requests to review</h3></div><span className="handover-count">{handovers.length}</span></div>
        {loading ? <p className="handover-empty">Loading requests…</p> : handovers.length === 0 ? <p className="handover-empty">No open specialist requests. New customer-approved handovers will appear here.</p> : <div className="handover-rows">{handovers.map((item) => <button key={item.groupKey} type="button" className={`handover-row${selectedId === item.groupKey ? " selected" : ""}`} onClick={() => setSelectedId(item.groupKey)}>
          <span className="handover-row-top"><strong>{item.contact?.name || item.contact?.phone || "Unknown contact"}</strong><span className={`handover-priority ${item.priority || "normal"}`}>{item.priority || "normal"}</span></span>
          <span>{item.department?.replaceAll("_", " ") || "General"} · {item.summary?.intent || "Request"}{item.groupCount > 1 ? ` · ${item.groupCount} linked requests` : ""}</span>
          <small>{dateLabel(item.createdAt)}</small>
        </button>)}</div>}
      </section>

      <section className="handover-detail panel" aria-label="Selected specialist request">
        {!selected ? <div className="handover-empty">Select a specialist request to review its context.</div> : <>
          <article className="handover-request-card">
            <div className="handover-request-topline"><span className="handover-request-label"><span className="handover-request-mark"><Bell size={14} /></span> Client request <span className="handover-request-department">{selected.department?.replaceAll("_", " ") || "General"}</span></span><span className={`handover-status-pill ${selected.status || "open"}`}><span />{selected.status || "open"}</span></div>
            <div className="handover-request-main"><div className="handover-request-heading"><h3>{selected.contact?.name || selected.contact?.phone || "Unknown contact"}</h3><p>{selected.summary?.intent || "Intent not classified"}<span> · </span>{dateLabel(selected.createdAt)}</p></div><button className="ghost handover-open-conversation" type="button" disabled={!selected.contact?.userId} onClick={() => onNavigate?.("conversations", selected.contact.userId)}>Open conversation <ArrowUpRight size={14} /></button></div>
            <div className="handover-need"><span>REQUEST SUMMARY</span><p>{selected.summary?.need || selected.summary?.opportunity || "No request summary was provided."}</p></div>
            <div className="handover-context"><div><small>Email</small><strong>{selected.contact?.email || "Not on file"}</strong></div><div><small>WhatsApp</small><strong>{selected.contact?.phone || "Available in conversation"}</strong></div></div>
            <div className="handover-request-footer"><div className="handover-alert-status"><Bell size={14} /><span>Admin alert</span><strong>{selected.alerts?.[0]?.status || (notificationSchemaReady ? "Not queued" : "Unavailable")}</strong>{selected.alerts?.[0]?.lastError && <small>{selected.alerts[0].lastError}</small>}</div><div className="handover-actions"><button className="ghost" type="button" disabled={busy || selected.status === "acknowledged"} onClick={() => void updateStatus("acknowledged")}><Check size={14} /> Acknowledge</button><button className="ghost" type="button" disabled={busy} onClick={() => void updateStatus("resolved")}><Check size={14} /> Mark resolved</button></div></div>
          </article>
          <form className="handover-draft-form" onSubmit={saveDraft}>
            <div className="handover-form-heading"><div><span className="handover-eyebrow">COMPOSE · NOT SENT</span><h4>Draft a customer follow-up</h4></div></div>
            <label>Channel<select value={channel} onChange={(event) => { const value = event.target.value; setChannel(value); setRecipient(value === "email" ? selected.contact?.email || "" : selected.contact?.whatsappJid || ""); }}><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select></label>
            {channel === "email" && <label>Subject<input maxLength={180} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Follow-up subject" /></label>}
            <label>{channel === "email" ? "Customer email" : "WhatsApp recipient"}<input required value={recipient} onChange={(event) => setRecipient(event.target.value)} autoComplete="off" /></label>
            <label>Message<textarea required maxLength={channel === "whatsapp" ? 1500 : 4000} rows={5} value={text} onChange={(event) => setText(event.target.value)} placeholder="Write a concise follow-up that responds to this request. Verify any service, price, or commitment against approved knowledge before sending." /></label>
            <div className="handover-form-footer"><span>Saving creates a draft only. Sending requires a separate admin approval.</span><button className="primary" type="submit" disabled={!notificationSchemaReady || busy || !recipient.trim() || !text.trim()}><Save size={14} /> {busy ? "Saving…" : "Save draft"}</button></div>
          </form>
          <section className="handover-drafts"><div className="handover-list-head"><div><span className="handover-eyebrow">OUTBOX</span><h4>Drafts and delivery</h4></div></div>{drafts.length ? drafts.map((draft) => <article className="handover-draft-card" key={draft.id}><div><strong>{draft.channel === "email" ? <Mail size={14} /> : <MessageCircle size={14} />} {draft.channel} · {draft.status}</strong><p>{draft.payload?.text || "Message content unavailable"}</p><small>{draft.recipient}</small></div>{draft.status === "draft" && <button className="primary" type="button" disabled={busy} onClick={() => void approveDraft(draft)}><Send size={14} /> Approve &amp; send</button>}</article>) : <p className="handover-empty">No follow-up drafts yet.</p>}</section>
        </>}
      </section>
    </div>
  </div>;
}
