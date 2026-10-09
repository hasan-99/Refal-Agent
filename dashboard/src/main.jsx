import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpenCheck,
  Building2,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  LogOut,
  Mail,
  MessageCircle,
  MessageCircleMore,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Phone,
  RefreshCcw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  ShieldBan,
  Sparkles,
  Unlink,
  Trash2,
  TrendingUp,
  UserRound,
  UserRoundPlus,
  UsersRound,
  X
} from "lucide-react";
import "./styles.css";
import { readSseData } from "./sse.js";
import { notificationJobLabel } from "../notificationLabels.js";
import { notificationBadgeText } from "../notificationBadge.js";
import { normalizeWhatsAppNumber } from "../phoneNumber.js";
import rafaLogo from "./assets/rafa-mark.png";
const Conversations = React.lazy(() => import("./Conversations.jsx"));
const Performance = React.lazy(() => import("./Performance.jsx"));
const HandoverInbox = React.lazy(() => import("./HandoverInbox.jsx"));
const FactRegister = React.lazy(() => import("./FactRegister.jsx"));

const navItems = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "agent-status", label: "Agent status", icon: Activity },
  { id: "performance", label: "Performance", icon: TrendingUp },
  { id: "conversations", label: "Conversations", icon: MessageCircleMore },
  { id: "knowledge", label: "Knowledge", icon: BookOpenCheck },
  // W3.9.7 — the fact register. Admin only: re-approval is an accountability
  // record, and blocking a fact removes it from retrieval entirely.
  { id: "facts", label: "Facts", icon: ShieldCheck, adminOnly: true },
  { id: "bookings", label: "Bookings", icon: CalendarClock },
  { id: "follow-ups", label: "Follow-ups", icon: Bell, adminOnly: true },
  { id: "blocked", label: "Blocked numbers", icon: ShieldBan, adminOnly: true }
];

const DASHBOARD_SECTION_STORAGE_KEY = "rafa-dashboard-active-section";
const DASHBOARD_CONVERSATION_VIEW_STORAGE_KEY = "rafa-dashboard-conversation-view";
const DASHBOARD_CONVERSATION_ID_STORAGE_KEY = "rafa-dashboard-conversation-id";
const dashboardSections = new Set([...navItems.map((item) => item.id), "account", "team"]);

function readInitialValue(param, key, allowed, fallback) {
  try {
    const urlValue = new URL(window.location.href).searchParams.get(param);
    if (allowed.has(urlValue)) return urlValue;
  } catch {
    // Fall back to local state below.
  }
  try {
    const value = window.localStorage.getItem(key);
    return allowed.has(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private contexts; navigation still works in memory.
  }
}

function readInitialConversationId() {
  try {
    const value = new URL(window.location.href).searchParams.get("conversation") || window.localStorage.getItem(DASHBOARD_CONVERSATION_ID_STORAGE_KEY);
    return String(value || "").slice(0, 220);
  } catch {
    return "";
  }
}

function App() {
  const [authState, setAuthState] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [outstandingNotificationCount, setOutstandingNotificationCount] = useState(0);
  const [notificationCountUnavailable, setNotificationCountUnavailable] = useState(false);
  const [active, setActive] = useState(() => readInitialValue("section", DASHBOARD_SECTION_STORAGE_KEY, dashboardSections, "overview"));
  const [conversationView, setConversationView] = useState(() => readInitialValue("view", DASHBOARD_CONVERSATION_VIEW_STORAGE_KEY, new Set(["inbox", "leads"]), "inbox"));
  const [selectedConversationId, setSelectedConversationId] = useState(readInitialConversationId);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [sidebarSettingsOpen, setSidebarSettingsOpen] = useState(false);
  const sidebarSettingsRef = useRef(null);

  useEffect(() => {
    let active = true;
    const start = async () => {
      const currentUrl = new URL(window.location.href);
      const code = currentUrl.searchParams.get("code");
      try {
        if (code) {
          await api("/api/auth/exchange-code", { method: "POST", body: JSON.stringify({ code }) });
          currentUrl.searchParams.delete("code");
          currentUrl.searchParams.delete("next");
          window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
          if (active) setAuthMode("reset");
        }
        const data = await api("/api/session");
        if (active) setAuthState(data);
      } catch (error) {
        if (active) setAuthState({ authenticated: false, error: error.message });
      }
    };
    start();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (authState?.role !== "admin" && active === "team") setActive("overview");
  }, [active, authState?.role]);

  useEffect(() => {
    if (dashboardSections.has(active)) writeStoredValue(DASHBOARD_SECTION_STORAGE_KEY, active);
  }, [active]);

  useEffect(() => {
    writeStoredValue(DASHBOARD_CONVERSATION_VIEW_STORAGE_KEY, conversationView);
  }, [conversationView]);

  useEffect(() => {
    writeStoredValue(DASHBOARD_CONVERSATION_ID_STORAGE_KEY, selectedConversationId);
  }, [selectedConversationId]);

  useEffect(() => {
    if (!authState?.authenticated) return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", active);
    if (active === "conversations") url.searchParams.set("view", conversationView);
    else url.searchParams.delete("view");
    if (active === "conversations" && selectedConversationId) url.searchParams.set("conversation", selectedConversationId);
    else url.searchParams.delete("conversation");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [active, authState?.authenticated, conversationView, selectedConversationId]);

  useEffect(() => {
    if (!authState?.authenticated) return undefined;
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/session", { credentials: "include", cache: "no-store" });
        const session = await response.json();
        if (!session.authenticated || session.role !== authState.role) {
          clearApiCache();
          setAuthState(session);
        }
      } catch { /* Keep the current screen during transient network loss. */ }
    }, 30000);
    return () => clearInterval(timer);
  }, [authState?.authenticated, authState?.role]);

  useEffect(() => {
    if (authState?.role !== "admin") { setOutstandingNotificationCount(0); setNotificationCountUnavailable(false); return undefined; }
    let mounted = true;
    const refreshCount = async () => {
      try {
        const result = await api("/api/handovers/summary");
        if (mounted) {
          setOutstandingNotificationCount(Math.max(0, Number(result.totalCount) || 0));
          setNotificationCountUnavailable(false);
        }
      } catch { if (mounted) setNotificationCountUnavailable(true); }
    };
    void refreshCount();
    const timer = setInterval(refreshCount, 20000);
    return () => { mounted = false; clearInterval(timer); };
  }, [authState?.role]);

  useEffect(() => {
    if (!sidebarSettingsOpen) return undefined;
    const closeOutside = (event) => {
      if (!sidebarSettingsRef.current?.contains(event.target)) setSidebarSettingsOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSidebarSettingsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [sidebarSettingsOpen]);

  if (authState === null) return <ScreenShell><Loading label="Checking secure session" /></ScreenShell>;
  if (!authState.authenticated || authState.role === "pending" || authMode === "reset") {
    return <Login
      authState={authState}
      mode={authMode}
      setMode={setAuthMode}
      onAuthenticated={(data) => { clearApiCache(); setAuthState(data); }}
      onResetComplete={() => { clearApiCache(); setAuthMode("login"); setAuthState({ authenticated: false }); }}
    />;
  }

  const isAdmin = authState.role === "admin";
  const roleLabel = isAdmin ? "Admin" : "User";
  const navigateTo = (section, view) => {
    if (section === "leads") {
      setConversationView("leads");
      setSelectedConversationId("");
      setActive("conversations");
      return;
    }
    if (section === "conversations" && ["inbox", "leads"].includes(view)) {
      setConversationView(view);
      setSelectedConversationId("");
    } else if (section === "conversations" && view) {
      setSelectedConversationId(String(view));
    } else if (section !== "conversations") {
      setSelectedConversationId("");
    }
    setActive(section);
  };
  const visibleNavItems = navItems.filter((item) => !item.adminOnly || isAdmin);
  const current = visibleNavItems.find((item) => item.id === active) ||
    (active === "team" ? { id: "team", label: "Team", icon: UserRoundPlus } : null) ||
    (active === "account" ? { id: "account", label: "Account", icon: UserRound } : null) ||
    visibleNavItems[0];
  const ActiveIcon = current.icon;

  return (
    <div className="app-shell">
      <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
        <div className="sidebar-head">
          <div className="brand">
            <div className="brand-mark"><img className="brand-logo" src={rafaLogo} alt="" /></div>
            <div className="brand-copy">
              <strong>REFAL</strong>
              <span>Agent control</span>
            </div>
          </div>
          <button className="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "Expand navigation" : "Minimize navigation"} title={sidebarCollapsed ? "Expand navigation" : "Minimize navigation"}>
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav aria-label="Dashboard sections">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={active === item.id ? "nav-item active" : "nav-item"}
                onClick={() => setActive(item.id)}
                aria-label={item.id === "follow-ups" && notificationCountUnavailable ? `${item.label}, count unavailable` : item.id === "follow-ups" && outstandingNotificationCount ? `${item.label}, ${notificationBadgeText(outstandingNotificationCount)} outstanding notifications` : item.label}
                title={sidebarCollapsed ? (item.id === "follow-ups" && notificationCountUnavailable ? `${item.label} · count unavailable` : item.id === "follow-ups" && outstandingNotificationCount ? `${item.label} · ${notificationBadgeText(outstandingNotificationCount)} notifications` : item.label) : undefined}
              >
                <Icon size={18} />
                <span className="nav-label">{item.label}</span>
                {item.id === "follow-ups" && !notificationCountUnavailable && outstandingNotificationCount > 0 && <span className="nav-notification-badge" aria-hidden="true">{notificationBadgeText(outstandingNotificationCount)}</span>}
                {item.id === "follow-ups" && notificationCountUnavailable && <span className="nav-notification-badge unavailable" aria-hidden="true">!</span>}
                <ChevronRight className="nav-chevron" size={15} />
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer" ref={sidebarSettingsRef}>
          <button className={sidebarSettingsOpen ? "sidebar-settings active" : "sidebar-settings"} type="button" onClick={() => setSidebarSettingsOpen((value) => !value)} aria-expanded={sidebarSettingsOpen} aria-label="Settings and account" title="Settings and account">
            <Settings size={17} /><span>Settings</span><ChevronDown className={sidebarSettingsOpen ? "settings-chevron open" : "settings-chevron"} size={15} />
          </button>
          {sidebarSettingsOpen && <div className="sidebar-settings-menu">
            <div className="sidebar-account-card">
              <span className="sidebar-account-avatar">{initials(authState.user?.email || roleLabel)}</span>
              <div>
                <strong>{authState.user?.email || "Workspace account"}</strong>
                <span>{roleLabel}</span>
              </div>
            </div>
            <button className="sidebar-menu-action" type="button" onClick={() => { setActive("account"); setSidebarSettingsOpen(false); }}><UserRound size={16} /><span>Account details</span><ChevronRight size={14} /></button>
            <button className="sidebar-menu-action" type="button" onClick={() => { setAuthMode("reset"); setSidebarSettingsOpen(false); }}><KeyRound size={16} /><span>Change password</span><ChevronRight size={14} /></button>
            {isAdmin && <button className="sidebar-menu-action" type="button" onClick={() => { setActive("team"); setSidebarSettingsOpen(false); }}><UserRoundPlus size={16} /><span>Manage team</span><ChevronRight size={14} /></button>}
            <button className="sidebar-menu-action disabled" type="button" disabled><Bell size={16} /><span>Notification preferences</span><small>Later</small></button>
            <button className="logout" onClick={() => api("/api/logout", { method: "POST" }).then(() => { clearApiCache(); setAuthState({ authenticated: false }); })} aria-label="Sign out"><LogOut size={17} /><span>Sign out</span></button>
          </div>}
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <div className="eyebrow"><ActiveIcon size={16} /> {current.label}</div>
            <h1>{current.label}</h1>
          </div>
          <div className="topbar-actions">
            <StatusPill />
          </div>
        </header>
        {active === "overview" && <Overview onNavigate={navigateTo} isAdmin={isAdmin} />}
        {active === "agent-status" && <AgentStatus isAdmin={isAdmin} />}
        {active === "performance" && <React.Suspense fallback={<Loading label="Loading performance" />}><Performance isAdmin={isAdmin} /></React.Suspense>}
        {active === "conversations" && <React.Suspense fallback={<Loading label="Loading conversations" />}><Conversations isAdmin={isAdmin} view={conversationView} onViewChange={setConversationView} selectedConversationId={selectedConversationId} onSelectedConversationChange={setSelectedConversationId} onNavigate={navigateTo} /></React.Suspense>}
        {active === "knowledge" && <Knowledge isAdmin={isAdmin} />}
        {active === "facts" && isAdmin && <React.Suspense fallback={<Loading label="Loading the fact register" />}><FactRegister isAdmin={isAdmin} /></React.Suspense>}
        {active === "bookings" && <Bookings isAdmin={isAdmin} />}
        {active === "follow-ups" && isAdmin && <React.Suspense fallback={<Loading label="Loading specialist follow-ups" />}><HandoverInbox onNavigate={navigateTo} /></React.Suspense>}
        {active === "blocked" && isAdmin && <BlockedNumbers />}
        {active === "account" && <AccountDetails authState={authState} />}
        {active === "team" && isAdmin && <Team />}
      </main>
      <AgentSidebar role={authState.role} />
    </div>
  );
}

function Login({ authState, mode, setMode, onAuthenticated, onResetComplete }) {
  const [email, setEmail] = useState(authState?.user?.email || "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const view = mode === "reset" ? "reset" : authState?.authenticated && authState.role === "pending" ? "bootstrap" : mode;

  async function submit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      if (view === "login") {
        const data = await api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
        onAuthenticated(data);
      } else if (view === "forgot") {
        const data = await api("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
        setMessage(data.message);
      } else if (view === "reset") {
        if (password !== confirmPassword) throw new Error("Those passwords do not match.");
        await api("/api/auth/update-password", { method: "POST", body: JSON.stringify({ password }) });
        onResetComplete();
      } else {
        await api("/api/auth/bootstrap-admin", { method: "POST", body: JSON.stringify({}) });
        onAuthenticated(await api("/api/session"));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenShell>
      <div className="auth-shell">
        <section className="auth-brand-panel">
          <img src={rafaLogo} alt="" />
          <span className="auth-kicker">Refalco Group WORKSPACE</span>
          <h1>Meet your work<br />with clarity.</h1>
          <p>One secure place for conversations, leads, knowledge, and bookings.</p>
          <div className="auth-brand-footer"><ShieldCheck size={15} /> Private team access</div>
        </section>
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form-heading">
            <span>{view === "bootstrap" ? "WORKSPACE SETUP" : "REFAL CONTROL"}</span>
            <h2>{view === "login" ? "Welcome back" : view === "forgot" ? "Reset your password" : view === "reset" ? "Choose a new password" : "Set up the first admin"}</h2>
            <p>{view === "login" ? "Sign in with your team account to continue." : view === "forgot" ? "We will send a secure reset link if this account is registered." : view === "reset" ? "Use at least 12 characters with uppercase, lowercase, and a number." : "This verified account can claim the one-time administrator role."}</p>
          </div>
          {view !== "bootstrap" && <label className="auth-field">
            <span>Email address</span>
            <span className="auth-input-wrap"><Mail size={17} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required disabled={view === "reset"} autoFocus /></span>
          </label>}
          {(view === "login" || view === "reset") && <>
            <label className="auth-field">
              <span>{view === "reset" ? "New password" : "Password"}</span>
              <span className="auth-input-wrap"><KeyRound size={17} /><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={view === "reset" ? "new-password" : "current-password"} required minLength={view === "reset" ? 12 : 1} /><button className="auth-password-toggle" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span>
            </label>
            {view === "reset" && <label className="auth-field">
              <span>Confirm new password</span>
              <span className="auth-input-wrap"><KeyRound size={17} /><input type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required minLength={12} /></span>
            </label>}
          </>}
          {error && <p className="auth-alert error" role="alert">{error}</p>}
          {message && <p className="auth-alert success" role="status">{message}</p>}
          {authState?.error && view === "login" && <p className="auth-alert error" role="alert">{authState.error}</p>}
          {view === "bootstrap" ? <button className="primary auth-submit" type="submit" disabled={busy}>{busy ? "Setting up" : "Initialize admin account"}<ArrowRight size={16} /></button> : <button className="primary auth-submit" type="submit" disabled={busy}>{busy ? "Please wait" : view === "login" ? "Sign in" : view === "forgot" ? "Send reset link" : "Update password"}<ArrowRight size={16} /></button>}
          {view === "login" && <button className="auth-link" type="button" onClick={() => { setError(""); setMessage(""); setMode("forgot"); }}>Forgot password?</button>}
          {view === "forgot" && <button className="auth-link" type="button" onClick={() => { setError(""); setMessage(""); setMode("login"); }}>Back to sign in</button>}
          {view === "reset" && <button className="auth-link" type="button" onClick={() => { setMode("login"); setError("The reset link is no longer active. Request a new one."); }}>Cancel password reset</button>}
          {view === "login" && <p className="auth-footnote">Accounts are created by a REFAL administrator.</p>}
        </form>
      </div>
    </ScreenShell>
  );
}

function ScreenShell({ children }) {
  return <div className="screen-shell">{children}</div>;
}

function AccountDetails({ authState }) {
  const email = authState.user?.email || "Workspace account";
  const role = authState.role === "admin" ? "Admin" : "User";
  const accessLabel = authState.user?.isActive === false ? "Disabled" : "Active";

  return <div className="page-stack account-page">
    <section className="account-intro">
      <span className="account-avatar">{initials(email)}</span>
      <div>
        <span className="eyebrow">ACCOUNT</span>
        <h2>{email}</h2>
        <p>Your dashboard identity and workspace access.</p>
      </div>
      <span className="account-role-badge">{role}</span>
    </section>
    <section className="account-grid">
      <article className="panel account-card">
        <div className="panel-title"><h2><Mail size={18} /> Profile</h2></div>
        <dl className="account-facts">
          <dt>Email</dt><dd>{email}</dd>
          <dt>Role</dt><dd>{role}</dd>
          <dt>Access</dt><dd>{accessLabel}</dd>
        </dl>
      </article>
      <article className="panel account-card">
        <div className="panel-title"><h2><Bell size={18} /> Notifications</h2><span className="badge cold">Later</span></div>
        <p className="account-muted">Notification preferences are reserved for the next pass.</p>
      </article>
    </section>
  </div>;
}

function Team() {
  const { data, loading, reload } = useApi("/api/admin/users");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function invite(event) {
    event.preventDefault();
    setBusy("invite"); setNotice(""); setError("");
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ email }) });
      setEmail(""); setNotice("Invitation sent. The new account has member access."); reload();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(""); }
  }

  async function update(user, patch) {
    setBusy(user.user_id); setNotice(""); setError("");
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.user_id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      setNotice("Team access updated."); reload();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(""); }
  }

  return <div className="page-stack team-page">
    <section className="team-intro"><div><span className="eyebrow">ACCESS CONTROL</span><h2>People in your REFAL workspace</h2><p>Invited accounts start with member access. Admins can manage knowledge, team access, and workspace settings.</p></div><div className="team-count"><strong>{data.users?.length || 0}</strong><span>accounts</span></div></section>
    <section className="panel team-invite"><div><h2>Invite a teammate</h2><p>They will receive an email to set their password.</p></div><form onSubmit={invite}><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" aria-label="Teammate email" required /><button className="primary" disabled={busy === "invite"}><Plus size={16} />{busy === "invite" ? "Sending" : "Send invitation"}</button></form></section>
    {notice && <p className="notice" role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}
    <section className="panel team-table"><div className="team-table-heading"><div><h2>Workspace access</h2><p>Changes apply on the next request and revoke access immediately.</p></div><button className="ghost icon-button" onClick={reload} aria-label="Refresh team" title="Refresh"><RefreshCcw size={16} /></button></div>
      {loading ? <Loading label="Loading team" /> : <div className="table-scroll"><table><thead><tr><th>Account</th><th>Status</th><th>Role</th><th>Access</th></tr></thead><tbody>{(data.users || []).map((user) => <tr key={user.user_id}><td><strong>{user.email}</strong><small>{user.confirmed ? `Joined ${formatDate(user.created_at)}` : "Email not confirmed"}</small></td><td><span className={`badge ${user.is_active ? "online" : "hot"}`}>{user.is_active ? "Active" : "Disabled"}</span></td><td><select value={user.role} disabled={busy === user.user_id} onChange={(event) => update(user, { role: event.target.value })} aria-label={`Role for ${user.email}`}><option value="user">Member</option><option value="admin">Admin</option></select></td><td><button className={user.is_active ? "ghost" : "primary"} disabled={busy === user.user_id} onClick={() => update(user, { isActive: !user.is_active })}>{user.is_active ? "Disable" : "Enable"}</button></td></tr>)}</tbody></table>{!data.users?.length && <p className="empty">No team accounts yet.</p>}</div>}
    </section>
  </div>;
}

function StatusPill() {
  const [overview, setOverview] = useState(null);
  useEffect(() => {
    api("/api/overview").then(setOverview).catch(() => {});
    const timer = setInterval(() => {
      api("/api/overview").then(setOverview).catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  const connected = overview?.status?.connected;
  const status = overview ? (connected ? "online" : "offline") : "checking";
  const label = status === "checking" ? "WhatsApp connecting" : `WhatsApp ${connected ? "online" : "offline"}`;
  return <span className={`status-indicator ${status}`} role="status" aria-label={label} title={label}><span className="status-dot" /><span>{label}</span></span>;
}

function AgentSidebar({ role }) {
  const [state, setState] = useState({ sessions: [], memories: [], session: null, messages: [] });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [error, setError] = useState("");
  const [section, setSection] = useState("chat");
  const isAdmin = role === "admin";
  const [collapsed, setCollapsed] = useState(true);
  const streamController = useRef(null);
  const chatEndRef = useRef(null);
  const chatListRef = useRef(null);
  const followStreamRef = useRef(true);
  const tokenBufferRef = useRef({ assistantId: "", text: "" });
  const tokenFrameRef = useRef(0);

  useEffect(() => {
    loadAgentState();
  }, []);

  useEffect(() => () => {
    if (tokenFrameRef.current) cancelAnimationFrame(tokenFrameRef.current);
  }, []);

  useEffect(() => {
    if (collapsed) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setCollapsed(true);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [collapsed]);

  useEffect(() => setModelInput(state.session?.model || ""), [state.session?.id, state.session?.model]);

  useEffect(() => {
    if (!isAdmin && section !== "chat" && section !== "history") setSection("chat");
  }, [isAdmin, section]);

  async function loadAgentState() {
    setLoading(true);
    setError("");
    try {
      setState(await api("/api/agent/state"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function openSession(sessionId) {
    streamController.current?.abort();
    setSending(false);
    setSection("chat");
    setCollapsed(false);
    setError("");
    try {
      const data = await api(`/api/agent/sessions/${encodeURIComponent(sessionId)}`);
      setState((current) => ({ ...current, ...data }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function newSession() {
    streamController.current?.abort();
    setSending(false);
    setError("");
    try {
      const data = await api("/api/agent/sessions", { method: "POST", body: JSON.stringify({ title: "New chat" }) });
      setState((current) => ({
        ...current,
        session: data.session,
        messages: [],
        sessions: [data.session, ...current.sessions]
      }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteSession(sessionId) {
    setError("");
    try {
      await api(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      const next = await api("/api/agent/state");
      setState(next);
    } catch (err) {
      setError(err.message);
    }
  }

  function flushStreamedTokens() {
    const { assistantId, text } = tokenBufferRef.current;
    tokenFrameRef.current = 0;
    if (!assistantId || !text) return;
    tokenBufferRef.current = { assistantId: "", text: "" };
    setState((current) => ({
      ...current,
      messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: item.content + text } : item)
    }));
  }

  function queueStreamToken(assistantId, token) {
    if (tokenBufferRef.current.assistantId && tokenBufferRef.current.assistantId !== assistantId) flushStreamedTokens();
    tokenBufferRef.current = {
      assistantId,
      text: `${tokenBufferRef.current.text}${token}`
    };
    if (!tokenFrameRef.current) tokenFrameRef.current = requestAnimationFrame(flushStreamedTokens);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const message = input.trim();
    if (!message || sending) return;
    setSending(true);
    setInput("");
    setError("");
    const controller = new AbortController();
    streamController.current = controller;
    const userId = `pending-user-${Date.now()}`;
    const assistantId = `pending-assistant-${Date.now()}`;
    setState((current) => ({
      ...current,
      messages: [
        ...(current.messages || []),
        { id: userId, role: "user", content: message, metadata: { pending: true } },
        { id: assistantId, role: "assistant", content: "", metadata: { pending: true } }
      ]
    }));
    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ sessionId: state.session?.id, message })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Request failed: ${response.status}`);
      }
      let completed = false;
      const handleEvent = (eventData) => {
          if (eventData.type === "meta") {
            setState((current) => ({ ...current, session: eventData.session, sessions: [eventData.session, ...(current.sessions || []).filter((item) => item.id !== eventData.session.id)] }));
          } else if (eventData.type === "token") {
            queueStreamToken(assistantId, eventData.token);
          } else if (eventData.type === "complete") {
            flushStreamedTokens();
            const { type: _type, ...data } = eventData;
            setState((current) => ({ ...current, ...data }));
            completed = true;
          } else if (eventData.type === "error") {
            throw new Error(eventData.error || "REFAL could not complete the response.");
          }
      };
      for await (const data of readSseData(response.body)) {
        let eventData;
        try { eventData = JSON.parse(data); } catch { continue; }
        handleEvent(eventData);
      }
      if (!completed) throw new Error("REFAL's response stream ended unexpectedly.");
    } catch (err) {
      if (err.name !== "AbortError") {
        flushStreamedTokens();
        setError(err.message);
        setState((current) => ({
          ...current,
          messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: item.content || "REFAL could not complete this response. Please try again.", metadata: { pending: false, error: true } } : item)
        }));
        if (err.message.startsWith("Request failed:")) setInput(message);
      }
    } finally {
      flushStreamedTokens();
      if (streamController.current === controller) streamController.current = null;
      setSending(false);
    }
  }

  async function saveMemory(event) {
    event.preventDefault();
    const content = memoryText.trim();
    if (!content) return;
    setError("");
    try {
      const data = await api("/api/agent/memories", {
        method: "POST",
        body: JSON.stringify({ label: titleFromMessage(content), content, sourceSessionId: state.session?.id, pinned: true })
      });
      setState((current) => ({ ...current, memories: data.memories }));
      setMemoryText("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteMemory(memoryId) {
    setError("");
    try {
      const data = await api(`/api/agent/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
      setState((current) => ({ ...current, memories: data.memories }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveAgentSettings(event) {
    event.preventDefault();
    if (!state.session || !modelInput.trim()) return;
    try {
      const data = await api(`/api/agent/sessions/${encodeURIComponent(state.session.id)}`, {
        method: "PUT",
        body: JSON.stringify({ model: modelInput.trim(), memoryEnabled: state.session.memory_enabled })
      });
      setState((current) => ({ ...current, session: data.session }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleSessionMemory(enabled) {
    if (!state.session) return;
    try {
      const data = await api(`/api/agent/sessions/${encodeURIComponent(state.session.id)}`, {
        method: "PUT",
        body: JSON.stringify({ memoryEnabled: enabled })
      });
      setState((current) => ({ ...current, session: data.session }));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (!followStreamRef.current) return;
    chatEndRef.current?.scrollIntoView({ behavior: sending ? "auto" : "smooth", block: "end" });
  }, [state.messages, sending]);

  return (
    <>
    {!collapsed && <button className="agent-backdrop" onClick={() => setCollapsed(true)} aria-label="Close REFAL chat" />}
    <aside className={collapsed ? "agent-rail collapsed" : "agent-rail"} role="dialog" aria-modal={!collapsed} aria-label="REFAL chat and tools">
      <div className="agent-rail-head">
        <div className="agent-identity"><span className="agent-avatar"><img src={rafaLogo} alt="" /></span><span><strong>REFAL</strong><small>Refalco Group agent</small></span></div>
        <div className="agent-head-actions">
          <button className="icon-button rail-toggle" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Open REFAL chat" : "Close REFAL chat"} title={collapsed ? "Open chat" : "Close chat"}>
            {collapsed ? <MessageCircle size={23} strokeWidth={2} /> : <X size={18} />}
          </button>
        </div>
      </div>

      <nav className="agent-nav" aria-label="REFAL tools">
        {[
          ["chat", MessageSquareText, "Chat"],
          ["history", Clock3, "History"],
          ...(isAdmin ? [["memory", BrainCircuit, "Memory"], ["settings", Settings, "Settings"]] : [])
        ].map(([id, Icon, label]) => (
          <button key={id} className={section === id ? "agent-nav-item active" : "agent-nav-item"} onClick={() => { setSection(id); setCollapsed(false); }} aria-label={label} title={label}>
            <Icon size={18} /><span>{label}</span>
          </button>
        ))}
      </nav>

      {error && <div className="agent-error">{error}</div>}

      {section === "history" && <section className="agent-history agent-view">
        <div className="rail-section-title">
          <span>Chat history</span>
          <button className="ghost mini-button" onClick={loadAgentState} aria-label="Refresh chat history" title="Refresh"><RefreshCcw size={14} /></button>
        </div>
        {loading ? <Loading label="Loading REFAL" /> : (
          <div className="session-list">
            {state.sessions.length ? state.sessions.map((session) => (
              <button
                key={session.id}
                className={state.session?.id === session.id ? "session-item active" : "session-item"}
                onClick={() => openSession(session.id)}
              >
                <span>{session.title}</span>
                <small>{formatDate(session.updated_at)}</small>
                <Trash2
                  size={14}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteSession(session.id);
                  }}
                />
              </button>
            )) : <p className="empty">No chats yet.</p>}
          </div>
        )}
      </section>}

      {section === "chat" && <section className="agent-chat agent-view">
        <div className="agent-chat-toolbar">
          <span>Conversation</span>
          <button className="new-chat-action" onClick={newSession}><Plus size={15} /> New chat</button>
        </div>
        <div className="agent-message-list" ref={chatListRef} onScroll={() => {
          const list = chatListRef.current;
          if (list) followStreamRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
        }} aria-live="polite" aria-busy={sending}>
          {(state.messages || []).length ? state.messages.map((message) => (
            <div key={message.id} className={message.role === "assistant" ? `agent-message assistant${message.metadata?.pending && message.content ? " agent-message-streaming" : ""}` : "agent-message user"} aria-label={message.role === "assistant" ? "REFAL response" : "Your message"}>
              <p dir="auto">{message.content || (sending && message.metadata?.pending ? <span className="agent-thinking">Thinking<span>...</span></span> : "")}</p>
            </div>
          )) : (
            <div className="agent-empty">
              <span className="agent-empty-mark"><img src={rafaLogo} alt="" /></span>
              <strong>What can I help with?</strong>
              <span>Ask about approved Refalco Group information or get help with your inbox.</span>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <form className="agent-composer" onSubmit={sendMessage}>
          <textarea
            dir="auto"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Message REFAL..."
            rows={3}
          />
          <button className="primary icon-button" type="submit" disabled={sending || !input.trim()} aria-label="Send message">
            <Send size={17} />
          </button>
        </form>
      </section>}

      {section === "memory" && <section className="agent-memory agent-view">
        <div className="rail-section-title">
          <span><BrainCircuit size={15} /> Memory</span>
        </div>
        <form className="memory-form" onSubmit={saveMemory}>
          <input value={memoryText} onChange={(event) => setMemoryText(event.target.value)} placeholder="Save a memory for REFAL" />
          <button className="ghost icon-button" type="submit" disabled={!memoryText.trim()} aria-label="Save memory"><Plus size={16} /></button>
        </form>
        <div className="memory-list">
          {(state.memories || []).slice(0, 5).map((memory) => (
            <div key={memory.id} className="memory-chip">
              <span>{memory.content}</span>
              <button className="icon-button" onClick={() => deleteMemory(memory.id)} aria-label="Delete memory"><X size={14} /></button>
            </div>
          ))}
          {!(state.memories || []).length && <p className="empty">No saved memory yet.</p>}
        </div>
      </section>}

      {section === "settings" && <section className="agent-settings agent-view">
        <div className="rail-section-title"><span>Agent settings</span></div>
        <form className="agent-model-form" onSubmit={saveAgentSettings}>
          <label>OpenRouter model<input value={modelInput} onChange={(event) => setModelInput(event.target.value)} placeholder="openai/gpt-6-luna" /></label>
          <button className="ghost" type="submit" disabled={!state.session || !modelInput.trim()}><Save size={15} /> Save model</button>
        </form>
        <label className="agent-memory-toggle"><input type="checkbox" checked={state.session?.memory_enabled !== false} disabled={!state.session} onChange={(event) => toggleSessionMemory(event.target.checked)} /> Use relevant saved memories in this chat</label>
        <div className="agent-setting-row"><span>Saved memories</span><strong>{state.memories?.length || 0}</strong></div>
        <button className="ghost agent-refresh" onClick={loadAgentState}><RefreshCcw size={15} /> Refresh agent data</button>
      </section>}
    </aside>
    </>
  );
}

function Knowledge({ isAdmin }) {
  const { data, setData, loading, reload } = useApi("/api/knowledge");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [importContent, setImportContent] = useState("");
  const [uploadFile, setUploadFile] = useState(null);
  const [knowledgeMode, setKnowledgeMode] = useState("text");
  const [knowledgeView, setKnowledgeView] = useState("content");
  const [editorMode, setEditorMode] = useState("update");
  const [editingDocument, setEditingDocument] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    if (!selectedId && data.documents?.length) setSelectedId(data.documents[0].source_id);
  }, [data.documents, selectedId]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setKnowledgeView("content");
    let active = true;
    api(`/api/knowledge/${encodeURIComponent(selectedId)}`)
      .then((value) => { if (active) setDetail(value); })
      .catch((value) => { if (active) setError(value.message); });
    return () => { active = false; };
  }, [selectedId, data.documents]);

  const sources = data.sources || [];
  const documents = data.documents || [];
  const selected = detail?.source || sources.find((source) => source.id === selectedId);

  function openKnowledgeEditor(document = null) {
    setKnowledgeMode("text");
    setEditingDocument(document);
    setEditorMode(document ? "update" : "new");
    setImportTitle(document?.title || "");
    setImportContent(document?.canonical_content || "");
    setUploadFile(null);
    setKnowledgeView("edit");
  }

  function startNewKnowledgeEntry() {
    setEditorMode("new");
    setEditingDocument(null);
    setImportTitle("");
    setImportContent("");
    setUploadFile(null);
    setKnowledgeMode("text");
  }

  async function run(action, fn) {
    setBusy(action); setError(""); setNotice("");
    try { const value = await fn(); setNotice(value?.message || "Saved."); reload(); }
    catch (value) { setError(value.message || "Request failed."); }
    finally { setBusy(""); }
  }

  async function fetchSource() {
    await run("fetch", async () => {
      const value = await api(`/api/knowledge/${selectedId}/fetch`, { method: "POST" });
      setDetail(await api(`/api/knowledge/${selectedId}`));
      return { message: value.deduplicated ? "No content change; existing revision kept." : `Revision saved with ${value.chunkCount} searchable chunks.` };
    });
  }

  async function importText(event) {
    event.preventDefault();
    await run("import", async () => {
      let targetSourceId = selectedId;
      let saved;
      if (editorMode === "update" && editingDocument?.id) {
        saved = await api(`/api/knowledge/documents/${editingDocument.id}`, { method: "PATCH", body: JSON.stringify({ title: importTitle, content: importContent }) });
      } else {
        const created = await api("/api/knowledge", { method: "POST", body: JSON.stringify({ displayName: importTitle }) });
        targetSourceId = created.source.id;
        const value = await api(`/api/knowledge/${targetSourceId}/import`, { method: "POST", body: JSON.stringify({ title: importTitle, content: importContent }) });
        saved = value;
        setSelectedId(targetSourceId);
      }
      setImportTitle(""); setImportContent(""); setEditingDocument(null); setEditorMode("new"); setKnowledgeView("content"); setDetail(await api(`/api/knowledge/${targetSourceId}`));
      if (saved.embeddingWarning) return { message: `Saved to the database. Text search is ready, but semantic indexing failed: ${saved.embeddingWarning}` };
      return { message: saved.unchanged ? "No changes detected. The database entry was left as it was." : editorMode === "update" ? "Changes saved to the database and REFAL search index." : `Added to the database and indexed in ${saved.embeddedChunks} searchable sections.` };
    });
  }

  async function uploadDocument(event) {
    event.preventDefault();
    await run("upload", async () => {
      let targetSourceId = selectedId;
      if (editorMode === "new") {
        const displayName = uploadFile.name.replace(/\.[^.]+$/, "").trim() || uploadFile.name;
        const created = await api("/api/knowledge", { method: "POST", body: JSON.stringify({ displayName }) });
        targetSourceId = created.source.id;
        setSelectedId(targetSourceId);
      }
      const formData = new FormData();
      formData.append("file", uploadFile);
      // Not the shared api() helper: it always forces Content-Type:
      // application/json, which would break the browser's own multipart
      // boundary for this file upload.
      const response = await fetch(`/api/knowledge/${targetSourceId}/upload`, { method: "POST", credentials: "include", body: formData });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || `Upload failed: ${response.status}`);
      setUploadFile(null); setEditingDocument(null); setEditorMode("new"); setKnowledgeView("content"); setDetail(await api(`/api/knowledge/${targetSourceId}`));
      return { message: value.embeddingWarning ? `Saved to the database. Text search is ready, but semantic indexing failed: ${value.embeddingWarning}` : value.unchanged ? "No changes detected. The database entry was left as it was." : `File added and indexed in ${value.embeddedChunks} searchable sections.` };
    });
  }

  async function deleteKnowledgeDocument(document) {
    await run(`delete-${document.id}`, async () => {
      await api(`/api/knowledge/${document.source_id}`, { method: "DELETE" });
      const refreshed = await api("/api/knowledge");
      setData(refreshed);
      const nextSourceId = refreshed.documents?.[0]?.source_id || "";
      setSelectedId(nextSourceId);
      setDetail(null);
      setDeleteTarget(null);
      if (editingDocument?.id === document.id) {
        setKnowledgeView("content"); setEditingDocument(null); setImportTitle(""); setImportContent("");
      }
      return { message: "Knowledge entry and searchable chunks deleted." };
    });
  }

  async function searchKnowledge(event) {
    event.preventDefault(); setSearching(true); setError("");
    try { setResults((await api("/api/knowledge/search", { method: "POST", body: JSON.stringify({ query }) })).results || []); }
    catch (value) { setError(value.message); }
    finally { setSearching(false); }
  }

  if (loading) return <Loading />;
  return (
    <div className="page-stack overview-page">
      <section className="knowledge-hero">
        <div>
          <span className="knowledge-hero-kicker"><BookOpenCheck size={14} /> REFAL KNOWLEDGE BASE</span>
          <h2>Give REFAL better context</h2>
          <p>Add or update company information. Saving replaces the database entry and refreshes REFAL’s searchable knowledge.</p>
        </div>
        <div className="knowledge-hero-note"><span className="knowledge-live-dot" /><span><strong>Active when saved</strong><small>Edits replace the current entry.</small></span></div>
      </section>
      <section className="knowledge-summary">
        <div><span>Company knowledge</span><strong>{documents.length}</strong><small>saved entries</small></div>
        <div><span>Saved knowledge entries</span><strong>{documents.length}</strong><small>active in REFAL</small></div>
        <form className="knowledge-search" onSubmit={searchKnowledge}>
          <label htmlFor="knowledge-query">Search approved knowledge</label>
          <div><input id="knowledge-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try a company, project, or contact question" /><button className="primary" disabled={searching || !query.trim()}><Search size={16} /> {searching ? "Searching" : "Search"}</button>{isAdmin && <button type="button" className="primary knowledge-search-add" onClick={() => openKnowledgeEditor()}><Plus size={16} /> Add knowledge</button>}</div>
        </form>
      </section>
      {error && <p className="error knowledge-message">{error}</p>}
      {notice && <p className="notice knowledge-message">{notice}</p>}
      {results.length > 0 && <section className="panel knowledge-results"><PanelTitle icon={Search} title={`Search results (${results.length})`} /><div className="knowledge-result-list">{results.map((result, index) => <article key={result.chunk_id || `${result.document_id}-${result.heading}-${index}`}><strong>{result.document_title}{result.heading ? ` · ${result.heading}` : ""}</strong><p>{result.content}</p><a href={result.source_url} target="_blank" rel="noreferrer">{result.source_name} <ChevronRight size={14} /></a></article>)}</div></section>}
      <div className="knowledge-layout">
        <section className="panel knowledge-sources">
          <PanelTitle icon={BookOpenCheck} title="Agent knowledge" />
          <div className="knowledge-source-list">
            {documents.map((doc) => {
              const source = sources.find((item) => item.id === doc.source_id);
              const snippet = String(doc.canonical_content || "").replace(/\s+/g, " ").trim();
              return <button key={doc.id} className={`knowledge-source${selectedId === doc.source_id ? " selected" : ""}`} onClick={() => setSelectedId(doc.source_id)}>
                <span className="knowledge-source-top"><strong dir="auto">{doc.title}</strong><span className="badge online">Active</span></span>
                <small>{source?.display_name || "Knowledge entry"}</small>
                <span className="knowledge-source-preview">{snippet.slice(0, 150)}{snippet.length > 150 ? "…" : ""}</span>
              </button>;
            })}
            {!documents.length && <p className="empty">Nothing active in REFAL’s knowledge database yet.</p>}
          </div>
        </section>
        <section className="panel knowledge-detail">
          {!selected ? <p className="empty">Select a knowledge entry to inspect its saved content.</p> : <>
            <PanelTitle icon={Building2} title={detail?.documents?.[0]?.title || selected.display_name} action={isAdmin && !String(selected.canonical_url || "").startsWith("manual:") && <button className="ghost" onClick={fetchSource} disabled={Boolean(busy)}><RefreshCcw size={15} /> {busy === "fetch" ? "Fetching" : "Fetch"}</button>} />
            {selected.last_error && <p className="knowledge-error">{selected.last_error}</p>}
            {knowledgeView === "content" && isAdmin && <div className="knowledge-entry-toolbar"><span>Saved content</span></div>}
            {isAdmin && knowledgeView === "edit" && <section className="knowledge-add-panel" aria-labelledby="knowledge-add-title">
              <div className="knowledge-add-heading"><div><span className="knowledge-add-kicker">KNOWLEDGE DATABASE</span><h3 id="knowledge-add-title">{editorMode === "update" ? `Edit ${editingDocument?.title || "saved knowledge"}` : "Add knowledge for REFAL"}</h3><p>{editorMode === "update" ? "Save replaces this database entry and refreshes REFAL search. Unchanged text is left alone." : "Add clear information for REFAL. Save activates it and updates the search index."}</p></div><button type="button" className="ghost" onClick={() => setKnowledgeView("content")}>Back to content</button></div>
              <div className="knowledge-editor-actions">
                <span>{editorMode === "update" ? `Editing revision v${editingDocument?.revision}` : "New entry"}</span>
                {editorMode === "update" && <button type="button" className="ghost" onClick={startNewKnowledgeEntry}>Start a new entry</button>}
              </div>
              <div className="knowledge-mode-switch" role="group" aria-label="Choose knowledge input type">
                <button type="button" className={knowledgeMode === "text" ? "selected" : ""} aria-pressed={knowledgeMode === "text"} onClick={() => setKnowledgeMode("text")}>Paste text</button>
                <button type="button" className={knowledgeMode === "file" ? "selected" : ""} aria-pressed={knowledgeMode === "file"} onClick={() => setKnowledgeMode("file")}>Upload a file</button>
              </div>
              {knowledgeMode === "text" ? <form className="knowledge-import" onSubmit={importText}>
                <label htmlFor="knowledge-title">Title</label>
                <input id="knowledge-title" required value={importTitle} onChange={(event) => setImportTitle(event.target.value)} placeholder="For example, Company setup FAQs" />
                <label htmlFor="knowledge-content">Knowledge text</label>
                <textarea id="knowledge-content" dir="auto" value={importContent} onChange={(event) => setImportContent(event.target.value)} placeholder="Paste company facts, service details, policies, or FAQs…" rows={7} />
                <div className="knowledge-submit-row"><small>At least 40 characters. Arabic and English text are both supported.</small><button className="primary" disabled={Boolean(busy) || !importTitle.trim() || importContent.trim().length < 40}><Save size={15} /> {busy === "import" ? "Saving and activating…" : editorMode === "update" ? "Save changes to database" : "Add to database"}</button></div>
              </form> : <form className="knowledge-upload" onSubmit={uploadDocument}>
                <label htmlFor="knowledge-file">Choose a text, PDF, or Word file</label>
                <input id="knowledge-file" type="file" accept=".txt,.pdf,.docx" aria-label="Choose a TXT, PDF, or DOCX knowledge file" onChange={(event) => setUploadFile(event.target.files?.[0] || null)} />
                <div className="knowledge-file-note"><BookOpenCheck size={18} /><span><strong>{uploadFile?.name || "Your file will become searchable knowledge"}</strong><small>REFAL will use its text in future answers after saving.</small></span></div>
                <div className="knowledge-submit-row"><small>Supported formats: TXT, PDF, DOCX.</small><button className="primary" disabled={Boolean(busy) || !uploadFile}><Plus size={15} /> {busy === "upload" ? "Saving and activating…" : "Add file to database"}</button></div>
              </form>}
            </section>}
            {knowledgeView === "content" && <div className="knowledge-revisions">
              {(detail?.documents || []).map((doc) => <article className="knowledge-revision" key={doc.id}>
                <div className="knowledge-revision-head"><div><strong>{doc.title}</strong><small>Updated {formatDate(doc.fetched_at)} · {doc.chunks.length} searchable sections{doc.metadata?.sourceFileType ? ` · ${doc.metadata.sourceFileType.toUpperCase()}` : ""}</small></div><span className="badge online">Active</span></div>
                <div className="knowledge-revision-content" dir="auto">{doc.canonical_content}</div>
                {isAdmin && <div className="knowledge-entry-actions"><button className="ghost" onClick={() => openKnowledgeEditor(doc)}><Save size={14} /> Edit</button><button className="knowledge-delete-button" onClick={() => setDeleteTarget(doc)} disabled={Boolean(busy)}><Trash2 size={14} /> Delete</button></div>}
              </article>)}
              {!detail?.documents?.length && <p className="empty">No knowledge saved yet. Select Add knowledge to paste text or upload a file.</p>}
            </div>}
          </>}
        </section>
      </div>
      {deleteTarget && <div className="knowledge-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteTarget(null); }}>
        <section className="knowledge-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-delete-title" aria-describedby="knowledge-delete-description">
          <span className="knowledge-delete-dialog-icon"><Trash2 size={19} /></span>
          <h2 id="knowledge-delete-title">Delete this knowledge?</h2>
          <p className="knowledge-delete-dialog-entry">{deleteTarget.title || "Saved knowledge"}</p>
          <p id="knowledge-delete-description">This permanently removes the entry, its source, and all searchable content from Supabase. REFAL will no longer use it in future answers.</p>
          <div className="knowledge-delete-dialog-actions">
            <button type="button" onClick={() => setDeleteTarget(null)} disabled={Boolean(busy)}>Cancel</button>
            <button type="button" className="knowledge-delete-confirm-button" onClick={() => deleteKnowledgeDocument(deleteTarget)} disabled={Boolean(busy)}>{busy === `delete-${deleteTarget.id}` ? <><span className="knowledge-delete-spinner" /> Deleting…</> : <><Trash2 size={14} /> Delete knowledge</>}</button>
          </div>
        </section>
      </div>}
    </div>
  );
}

function Overview({ onNavigate, isAdmin }) {
  const { data, loading, reload } = useApi("/api/overview", [], { pollMs: 15000 });
  const [downloading, setDownloading] = useState(false);
  if (loading) return <Loading />;

  const stats = data.stats || {};
  const contactActivity = data.contactActivity || {};
  const activeContacts = numberValue(contactActivity.activeLast7Days);
  const totalContacts = numberValue(contactActivity.contacts);
  const weeklyActivity = totalContacts > 0 ? Math.min(100, Math.round((activeContacts / totalContacts) * 100)) : 0;
  async function downloadReport() {
    setDownloading(true);
    try {
      const response = await fetch("/api/reports/download", {
        method: "POST",
        credentials: "include"
      });
      if (!response.ok) throw new Error("Report download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `whatsapp-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      reload();
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="page-stack overview-page">
      <section className="overview-intro">
        <div className="overview-intro-copy">
          <div className="eyebrow"><Activity size={15} /> WORKSPACE OVERVIEW</div>
          <h2>The customer pulse</h2>
          <p>See who is engaging with REFAL and move straight from activity to action.</p>
          <div className="overview-actions">
            <button className="ghost" onClick={() => onNavigate("leads")}><UsersRound size={16} /> Review leads <ArrowUpRight size={14} /></button>
          </div>
        </div>
      </section>

      <section className="metric-grid">
        <Metric icon={MessageSquareText} title="Conversations today" value={stats.conversationsToday} label="Customer threads" />
        <Metric icon={TrendingUp} title="Conversations this week" value={stats.conversationsThisWeek} label="Customer threads" />
        <Metric icon={BarChart3} title="Conversations this month" value={stats.conversationsThisMonth} label="Customer threads" />
        <Metric icon={MessageCircle} title="Messages today" value={stats.messagesToday} label={`${data.voiceNotesToday || 0} voice notes`} />
      </section>

      <section className="overview-grid overview-summary-grid">
        <div className="panel contact-activity-panel">
          <PanelTitle icon={UsersRound} title="Contact activity" action={<button className="ghost" onClick={() => onNavigate("leads")}>All leads <ArrowUpRight size={14} /></button>} />
          <div className="contact-activity-highlight">
            <div className="contact-activity-highlight-copy">
              <span className="contact-activity-kicker">CUSTOMER ACTIVITY · LAST 7 DAYS</span>
              <strong>{activeContacts} of {totalContacts}</strong>
              <span>contacts engaged</span>
            </div>
            <div className="contact-activity-track" role="progressbar" aria-label="Contacts engaged in the last 7 days" aria-valuemin="0" aria-valuemax={totalContacts || 1} aria-valuenow={Math.min(activeContacts, totalContacts)}>
              <span style={{ width: `${weeklyActivity}%` }} />
            </div>
          </div>
          <div className="contact-activity-support">
            <div><span>Total contacts</span><strong>{totalContacts}</strong></div>
            <div><span>With conversations</span><strong>{numberValue(contactActivity.contactsWithConversations)}</strong></div>
          </div>
        </div>

        <div className="panel overview-reports-panel">
          <PanelTitle
            icon={BookOpenCheck}
            title="Recent reports"
            action={isAdmin && <button className="primary" onClick={downloadReport} disabled={downloading}>{downloading ? "Generating" : "Download"}</button>}
          />
          <SimpleList
            items={(data.reports || []).slice(0, 3)}
            empty="No reports generated yet."
            render={(report) => (
              <>
                <strong>{report.name}</strong>
                <span>{formatDate(report.modifiedAt)} · {report.userCount} contacts · {report.rowCount} turns</span>
              </>
            )}
          />
        </div>
      </section>
    </div>
  );
}

function AgentStatus({ isAdmin }) {
  const { data: overviewData, loading: overviewLoading, reload: reloadOverview, error: overviewError } = useApi("/api/overview", [], { pollMs: 15000 });
  const [controlRefresh, setControlRefresh] = useState(0);
  const loading = overviewLoading;
  const status = overviewData.status || {};
  const usage = overviewData.usage || {};
  const whatsappReady = status.connected === true;

  function refreshAll() {
    reloadOverview();
    setControlRefresh((value) => value + 1);
  }

  return <div className="page-stack agent-status-page">
    <section className="agent-status-intro">
      <div><span className="eyebrow"><Activity size={14} /> REFAL HEALTH</span><h2>Agent status</h2><p>WhatsApp connection and AI usage.</p></div>
      <button className="ghost" onClick={refreshAll} aria-label="Refresh agent status"><RefreshCcw size={15} /> Refresh</button>
    </section>

    {overviewError && <div className="agent-status-error" role="alert"><span>{overviewError}</span><button className="ghost" onClick={refreshAll}>Try again</button></div>}

    {loading && <section className="panel agent-status-loading"><Loading label="Checking agent health" /></section>}

    <section className="agent-status-grid" aria-label="WhatsApp connection and AI usage">
      <article className={`panel agent-status-card agent-status-whatsapp ${whatsappReady ? "ready" : "attention"}`}>
        <PanelTitle icon={MessageCircle} title="WhatsApp connection" action={<span className={`agent-status-badge ${whatsappReady ? "ready" : "attention"}`}><i />{whatsappReady ? "Connected" : status.connected === false ? "Disconnected" : "Checking"}</span>} />
        <dl className="facts"><dt>Last status update</dt><dd>{formatDate(status.lastSeen)}</dd></dl>
        {isAdmin ? <WhatsAppControl refreshKey={controlRefresh} onStatusChange={reloadOverview} /> : <p className="agent-status-member-note">Connection controls are managed by a workspace admin.</p>}
      </article>

      <article className="panel agent-status-card agent-usage-card">
        <PanelTitle icon={Sparkles} title="AI usage" />
        {overviewLoading ? <Loading label="Loading usage" /> : <>
          <dl className="facts compact-facts">
            <dt>Model</dt><dd>{usage.model || "Not set"}</dd>
            <dt>Requests</dt><dd>{Number(usage.aiRequests || 0).toLocaleString()}</dd>
            <dt>Tokens</dt><dd>{Number(usage.estimatedTokens || 0).toLocaleString()}</dd>
            <dt>Estimated cost</dt><dd>${Number(usage.estimatedCost || 0).toFixed(4)}</dd>
          </dl>
          <p className="hint">Cost is estimated from message counts and configured model assumptions.</p>
        </>}
      </article>
    </section>
  </div>;
}

function WhatsAppControl({ refreshKey = 0, onStatusChange = null }) {
  const [control, setControl] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [pairingMethod, setPairingMethod] = useState("qr");
  const [pairingQrImage, setPairingQrImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const previousState = useRef(null);
  const toastTimer = useRef(null);

  function showToast(message, tone = "info") {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 5500);
  }

  async function refresh() {
    const response = await fetch("/api/whatsapp/control", { credentials: "include", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not read WhatsApp status.");
    setControl(data);
  }

  useEffect(() => {
    refresh().catch((cause) => showToast(cause.message, "error"));
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [refreshKey]);

  useEffect(() => {
    const previous = previousState.current;
    previousState.current = control?.state || null;
    if (!control || !previous || previous === control.state) return;
    if (control.state === "pairing") showToast(control.pairingMethod === "qr" ? "WhatsApp QR code ready to scan." : "Pairing code ready. Enter it on your primary phone.", "success");
    else if (control.state === "connected") showToast("REFAL is connected to WhatsApp.", "success");
    else if (control.state === "error") showToast(control.error || "WhatsApp connection failed.", "error");
    else if (control.state === "disconnected" && ["connected", "pairing", "stopping"].includes(previous)) showToast("REFAL disconnected from WhatsApp.", "info");
  }, [control?.state, control?.error]);

  useEffect(() => {
    let current = true;
    if (control?.state !== "pairing" || control.pairingMethod !== "qr" || !control.pairingQr) {
      setPairingQrImage("");
      return () => { current = false; };
    }
    import("qrcode").then(({ default: QRCode }) => QRCode.toDataURL(control.pairingQr, { errorCorrectionLevel: "M", margin: 2, width: 240 }))
      .then((image) => { if (current) setPairingQrImage(image); })
      .catch(() => { if (current) showToast("Could not render the WhatsApp QR. Try phone-code pairing.", "error"); });
    return () => { current = false; };
  }, [control?.state, control?.pairingMethod, control?.pairingQr]);

  useEffect(() => {
    if (!control || !(["connecting", "pairing", "stopping"].includes(control.state) || (control.state === "error" && control.managed))) return undefined;
    const timer = setInterval(() => refresh().catch(() => {}), 1500);
    return () => clearInterval(timer);
  }, [control?.state]);

  async function connect(event) {
    event.preventDefault();
    const normalizedNumber = normalizeWhatsAppNumber(phoneNumber);
    if (!normalizedNumber) {
      showToast("That number does not match a valid international phone-number format. Check the country code and every digit.", "error");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/whatsapp/connect", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneNumber: normalizedNumber, pairingMethod })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not connect WhatsApp.");
      setControl(data);
      onStatusChange?.();
      showToast("Starting WhatsApp connection…", "info");
    } catch (cause) { showToast(cause.message, "error"); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch("/api/whatsapp/disconnect", { method: "POST", credentials: "include", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not disconnect WhatsApp.");
      setControl(data);
      onStatusChange?.();
      showToast("Disconnecting REFAL…", "info");
    } catch (cause) { showToast(cause.message, "error"); }
    finally { setBusy(false); }
  }

  async function stopLocalWorker() {
    setBusy(true);
    try {
      const response = await fetch("/api/whatsapp/stop-local-worker", { method: "POST", credentials: "include", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not stop local REFAL.");
      setControl(data);
      onStatusChange?.();
      showToast(data.stoppedExternal ? "Local REFAL worker stopped." : "No local REFAL worker was running.", "info");
    } catch (cause) { showToast(cause.message, "error"); }
    finally { setBusy(false); }
  }

  const connected = control?.state === "connected";
  const active = control && (["connecting", "pairing", "connected", "stopping"].includes(control.state) || (control.state === "error" && control.managed));
  const externallyConnected = connected && control?.external;
  return <div className="whatsapp-control" aria-live="polite">
    <div className="whatsapp-control-heading">
      <span className={`whatsapp-control-dot ${connected ? "online" : ""}`} />
      <strong>{connected ? "REFAL is connected" : control?.state === "pairing" ? "Waiting for device link" : control?.state === "connecting" ? "Starting WhatsApp" : control?.state === "stopping" ? "Disconnecting" : control?.state === "error" ? "Connection needs attention" : "WhatsApp is disconnected"}</strong>
    </div>
    {control?.phoneNumber && <span className="whatsapp-control-number">{control.phoneNumber}</span>}
    {externallyConnected && <small className="whatsapp-control-note">REFAL is running from the saved WhatsApp session.</small>}
    {control?.state === "pairing" && control.pairingMethod === "qr" && control.pairingQr && <div className="whatsapp-pairing-qr">
      <span>Scan with the primary WhatsApp phone</span>
      {pairingQrImage ? <img src={pairingQrImage} alt="Temporary WhatsApp device-link QR code" /> : <span className="qr-loading">Preparing QR…</span>}
      <small>Android: ⋮ → Linked devices. iPhone: Settings → Linked Devices. Tap Link a device and scan this code. Confirm that the linked number matches the number above. QR codes expire; disconnect and reconnect for a new one.</small>
    </div>}
    {control?.state === "pairing" && control.pairingCode && <div className="whatsapp-pairing-code">
      <span>Enter this code on your primary phone</span><strong>{control.pairingCode}</strong>
      <small>On the primary phone signed in to the number above: Android: ⋮ → Linked devices. iPhone: Settings → Linked Devices. Tap Link a device → Link with phone number, approve the new device, then enter this 8-character code. Codes expire; disconnect and reconnect to request another.</small>
    </div>}
    {!active && <form className="whatsapp-connect-form" onSubmit={connect}>
      <div className="pairing-method" role="group" aria-label="WhatsApp linking method">
        <button type="button" className={pairingMethod === "qr" ? "selected" : ""} aria-pressed={pairingMethod === "qr"} onClick={() => setPairingMethod("qr")}>QR scan</button>
        <button type="button" className={pairingMethod === "code" ? "selected" : ""} aria-pressed={pairingMethod === "code"} onClick={() => setPairingMethod("code")}>Phone code</button>
      </div>
      <label htmlFor="rafa-whatsapp-number">WhatsApp number</label>
      <div><input id="rafa-whatsapp-number" type="tel" inputMode="tel" autoComplete="tel" placeholder="+35799123456" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} required pattern="\\+[0-9 ()-]{8,24}" title="Use a valid full international WhatsApp number beginning with + and including country code." /><button className="primary" type="submit" disabled={busy}>{busy ? "Starting" : <><Link2 size={15} /> {pairingMethod === "qr" ? "Connect with QR" : "Get phone code"}</>}</button></div>
      <small>Enter the exact international number for the WhatsApp account on your primary phone.</small>
    </form>}
    {active && !externallyConnected && <button className="whatsapp-disconnect" type="button" onClick={disconnect} disabled={busy || control.state === "stopping"}><Unlink size={14} /> Disconnect REFAL</button>}
    {externallyConnected && <button className="whatsapp-disconnect" type="button" onClick={stopLocalWorker} disabled={busy}><Unlink size={14} /> Stop local REFAL</button>}
    {toast && <div className={`app-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span>{toast.message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button>
    </div>}
  </div>;
}

function Leads({ isAdmin }) {
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const { data, loading, reload } = useApi("/api/leads", [], { pollMs: 15000 });
  const users = useMemo(() => {
    const all = data.users || [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((user) => [user.phone, user.name, user.id, user.lastMessagePreview].join(" ").toLowerCase().includes(q));
  }, [data.users, query]);

  const summary = useMemo(() => ({
    contacts: users.length,
    active: users.filter((user) => {
      const at = new Date(user.lastMessageAt || 0).getTime();
      return Number.isFinite(at) && at <= Date.now() && Date.now() - at < 7 * 24 * 60 * 60 * 1000;
    }).length,
    turns: users.reduce((total, user) => total + Number(user.conversationCount || 0), 0)
  }), [users]);

  return (
    <div className="page-stack">
      <section className="lead-command">
        <MiniStat icon={UsersRound} label="Total leads" value={summary.contacts} />
        <MiniStat icon={Activity} label="Active · 7 days" value={summary.active} />
        <MiniStat icon={MessageCircle} label="Conversation turns" value={summary.turns} />
        <div className="lead-command-copy">
          <strong>Lead inbox</strong>
          <span>Every saved WhatsApp contact is counted, including contacts whose name is not known yet.</span>
        </div>
      </section>

      <section className="toolbar">
        <div className="search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search number, name, message" />
        </div>
        <button className="ghost" onClick={reload}><RefreshCcw size={16} /> Refresh</button>
      </section>

      <section className="panel table-panel">
        {loading ? <Loading /> : (
          <table>
            <thead>
              <tr>
                <th>Lead</th>
                <th>Conversation turns</th>
                <th>Last message</th>
                <th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} onClick={() => setSelected(user.id)}>
                  <td>
                    <div className="lead-person">
                      <span className="avatar">{initials(user.name || user.phone || user.id)}</span>
                      <div>
                        <strong>{user.name || "Name not set"}</strong>
                        <span>{user.phone || user.id}</span>
                      </div>
                    </div>
                  </td>
                  <td>{Number(user.conversationCount || 0).toLocaleString()}</td>
                  <td>{formatDate(user.lastMessageAt)}</td>
                  <td className="preview-cell">{user.lastMessagePreview || "No message"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {selected && <ConversationDrawer userId={selected} isAdmin={isAdmin} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ConversationDrawer({ userId, isAdmin, onClose }) {
  const { data, setData, loading } = useApi(`/api/leads/${encodeURIComponent(userId)}`, [userId]);
  const [contact, setContact] = useState({ nameOverride: "", phoneOverride: "", needOverride: "", conversationSummary: "" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setContact({
      nameOverride: data.user?.nameOverride || "",
      phoneOverride: data.user?.phoneOverride || "",
      needOverride: data.profile?.needOverride || "",
      conversationSummary: data.profile?.conversationSummary || ""
    });
  }, [data.user?.nameOverride, data.user?.phoneOverride]);

  async function saveContact() {
    setSaving(true);
    setMessage("");
    try {
      const saved = await api(`/api/leads/${encodeURIComponent(userId)}/contact`, {
        method: "PUT",
        body: JSON.stringify(contact)
      });
      setData({ ...data, user: saved.user, profile: saved.profile });
      setMessage("Contact saved.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div className="drawer-profile">
          <span className="avatar large-avatar">{initials(data.user?.name || data.user?.phone || userId)}</span>
          <div>
            <strong>{data.user?.name || "Unnamed lead"}</strong>
            <span><Phone size={14} /> {data.user?.phone || userId}</span>
            {data.user?.rawPhone && data.user.rawPhone !== data.user.phone && <small>Raw ID: {data.user.rawPhone}</small>}
          </div>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close conversation"><X size={18} /></button>
      </div>
      {loading ? <Loading /> : (
        <div className="conversation">
          <section className="drawer-activity">
            <MiniStat icon={MessageCircle} label="Conversation turns" value={data.user?.conversationCount ?? data.history?.length ?? 0} />
            <span>Last activity {formatDate(data.user?.lastMessageAt)}</span>
          </section>

          {isAdmin && <section className="contact-editor">
            <label>
              Correct name
              <input
                value={contact.nameOverride}
                onChange={(event) => setContact({ ...contact, nameOverride: event.target.value })}
                placeholder={data.user?.name || "Name from onboarding"}
              />
            </label>
            <label>
              Correct WhatsApp number
              <input
                value={contact.phoneOverride}
                onChange={(event) => setContact({ ...contact, phoneOverride: event.target.value })}
                placeholder={data.user?.phone || "+357..."}
              />
            </label>
            <label>
              Correct client service interest
              <input value={contact.needOverride} maxLength={160} onChange={(event) => setContact({ ...contact, needOverride: event.target.value })} placeholder={data.profile?.need || "No stated service interest"} />
            </label>
            <label>
              Client-specific memory (never used as company facts)
              <textarea value={contact.conversationSummary} maxLength={700} rows={3} onChange={(event) => setContact({ ...contact, conversationSummary: event.target.value })} placeholder="No saved client memory" />
            </label>
            <button className="primary" onClick={saveContact} disabled={saving}>
              <Save size={16} /> {saving ? "Saving" : "Save"}
            </button>
            {message && <span>{message}</span>}
          </section>}

          {(data.history || []).map((item, index) => (
            <div className="turn" key={`${item.at}-${index}`}>
              <time>{formatDate(item.at)}</time>
              <div className="bubble user" dir="auto" aria-label="Customer message">{item.message}</div>
              <div className="bubble agent" dir="auto" aria-label="REFAL response">{item.response}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function BlockedNumbers() {
  const { data, loading, error, reload } = useApi("/api/blocks", [], { pollMs: 15000 });
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("harassment");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const visible = blocks.filter((block) => showInactive || block.status === "active");
  const activeCount = blocks.filter((block) => block.status === "active").length;
  const historyCount = blocks.length - activeCount;

  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const entered = userId.trim();
      const jid = entered.includes("@") ? entered : `${entered.replace(/\D/g, "")}@s.whatsapp.net`;
      await api("/api/blocks", { method: "POST", body: JSON.stringify({ userId: jid, reason, category }) });
      setUserId(""); setReason(""); setMessage("Number blocked and recorded."); reload();
    } catch (cause) { setMessage(cause.message || "Could not block number."); }
    finally { setBusy(false); }
  }

  async function unblock(block) {
    const note = window.prompt("Optional note for the unblock audit record:") || "";
    setBusy(true); setMessage("");
    try { await api(`/api/blocks/${encodeURIComponent(block.id)}`, { method: "PATCH", body: JSON.stringify({ reason: note }) }); setMessage("Number unblocked."); reload(); }
    catch (cause) { setMessage(cause.message || "Could not unblock number."); }
    finally { setBusy(false); }
  }

  return <div className="page-stack blocked-page">
    <section className="blocked-hero">
      <div className="blocked-hero-main">
        <span className="blocked-kicker"><ShieldBan size={14} /> SAFETY &amp; MODERATION</span>
        <h2>Keep conversations safe.</h2>
        <p>Review restricted WhatsApp contacts and document the reason for every decision.</p>
      </div>
      <div className="blocked-summary" aria-label="Block summary">
        <div><span className="blocked-summary-dot active" /><strong>{activeCount}</strong><span>Active blocks</span></div>
        <div><span className="blocked-summary-dot history" /><strong>{historyCount}</strong><span>Unblocked records</span></div>
      </div>
    </section>

    <section className="blocked-create panel">
      <div className="blocked-section-heading">
        <span className="blocked-section-icon"><ShieldBan size={19} /></span>
        <div><span className="blocked-eyebrow">ADMIN ACTION</span><h3>Block a number</h3><p>Save a contact and a concise, factual reason for the moderation log.</p></div>
      </div>
      <div className="blocked-guidance"><strong>Use blocking only when necessary.</strong> Severe or repeated harassment, threats, or spam qualify. Complaints, difficult questions, and ordinary criticism do not.</div>
      <form className="blocked-form" onSubmit={submit}>
        <label className="field">WhatsApp number or JID<input required value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="+357 99 123456" autoComplete="off" /></label>
        <label className="field">Reason category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="harassment">Harassment</option><option value="threat">Threat</option><option value="spam">Spam</option><option value="other">Other</option></select></label>
        <label className="field blocked-reason-field">Reason for blocking<textarea required maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Describe the behavior. Avoid unnecessary personal details." /></label>
        <div className="blocked-form-action"><span>Visible to admins in the review log.</span><button className="blocked-submit" disabled={busy || !userId.trim() || !reason.trim()}><ShieldBan size={16} />{busy ? "Saving…" : "Block contact"}</button></div>
      </form>
      {message && <p className="blocked-feedback" role="status">{message}</p>}
    </section>

    <section className="blocked-review panel">
      <div className="blocked-review-heading">
        <div className="blocked-section-heading">
          <span className="blocked-section-icon review"><UsersRound size={19} /></span>
          <div><span className="blocked-eyebrow">CONTACT LOG</span><h3>Block review</h3><p>Audit reasons, status, and who recorded each action.</p></div>
        </div>
        <label className={`blocked-history-toggle${showInactive ? " is-on" : ""}`}><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /><span className="blocked-toggle-track" /><span>Include unblocked</span></label>
      </div>
      {error && <div className="blocked-error" role="alert"><span>{error}</span><button className="ghost" onClick={reload}>Try again</button></div>}
      {loading ? <div className="blocked-loading"><Loading label="Loading block records" /></div> : visible.length === 0 ? <div className="blocked-empty"><span className="blocked-empty-icon"><ShieldBan size={21} /></span><strong>{showInactive ? "No block records yet" : "No active blocks"}</strong><p>{showInactive ? "When a number is blocked or unblocked, its audit record will appear here." : "No contacts are currently restricted. New block actions will be listed here for review."}</p></div> : <div className="table-scroll blocked-table-wrap"><table className="blocked-table"><thead><tr><th>CONTACT</th><th>REASON</th><th>STATUS</th><th>RECORDED</th><th>ADMIN</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {visible.map((block) => <tr key={block.id}><td><span className="blocked-contact"><span className="blocked-contact-mark"><UsersRound size={15} /></span><strong>{block.whatsapp_jid}</strong></span></td><td><span className="blocked-reason">{block.reason}</span><small className="blocked-category">{block.category}</small></td><td><span className={`blocked-status ${block.status === "active" ? "is-active" : "is-inactive"}`}><i />{block.status === "active" ? "Active" : "Unblocked"}</span></td><td className="blocked-date">{formatDate(block.created_at)}</td><td className="blocked-admin">{block.created_by || "—"}</td><td className="blocked-row-action">{block.status === "active" && <button className="blocked-unblock" disabled={busy} onClick={() => unblock(block)}>Unblock</button>}</td></tr>)}
      </tbody></table></div>}
    </section>
  </div>;
}

function Bookings({ isAdmin }) {
  const { data: readiness, reload: reloadReadiness } = useApi("/api/bookings/readiness");
  const { data: notificationData, reload: reloadNotifications } = useApi(isAdmin ? "/api/notifications" : "/api/bookings/readiness", [], { pollMs: 30000 });
  const [policy, setPolicy] = useState(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMessage, setPolicyMessage] = useState("");
  const [calendarTestBusy, setCalendarTestBusy] = useState(false);
  const [calendarTestMessage, setCalendarTestMessage] = useState("");
  const [calendarTestError, setCalendarTestError] = useState(false);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reviewing, setReviewing] = useState("");

  useEffect(() => {
    if (!readiness) return;
    setPolicy(readiness.policy || {
      timezone: "Europe/Nicosia", calendarId: "primary", weekdays: [1, 2, 3, 4, 5],
      startTime: "10:00", endTime: "15:00", durationMinutes: "", durationOwnerConfirmed: false,
      minimumNoticeHours: "", reminderHours: [], createMeetLink: false
    });
  }, [readiness]);

  const savePolicy = async () => {
    setPolicyBusy(true); setPolicyMessage("");
    try {
      const result = await api("/api/bookings/policy", { method: "PUT", body: JSON.stringify({ policy: {
        ...policy,
        durationMinutes: policy.durationMinutes === "" ? null : Number(policy.durationMinutes),
        minimumNoticeHours: policy.minimumNoticeHours === "" ? null : Number(policy.minimumNoticeHours),
        reminderHours: (Array.isArray(policy.reminderHours) ? policy.reminderHours : String(policy.reminderHours || "").split(",")).map(Number).filter(Boolean)
      } }) });
      setPolicy(result.policy); setPolicyMessage("Booking policy saved to Supabase.");
      reloadReadiness();
    } catch (cause) { setPolicyMessage(cause.message || "Could not save booking policy."); }
    finally { setPolicyBusy(false); }
  };

  const testCalendarAccess = async () => {
    setCalendarTestBusy(true); setCalendarTestMessage(""); setCalendarTestError(false);
    try {
      const result = await api("/api/bookings/test-calendar", { method: "POST" });
      setCalendarTestMessage(`REFAL can access ${result.access.calendarId}. Verified ${formatDate(result.access.checkedAt)}.`);
      reloadReadiness();
    } catch (cause) {
      setCalendarTestMessage(cause.message || "Could not verify Google Calendar access.");
      setCalendarTestError(true);
    } finally { setCalendarTestBusy(false); }
  };

  const reviewAppointment = async (booking, action) => {
    const reason = ["reject", "cancel", "reschedule"].includes(action) ? (window.prompt(action === "reject" ? "Short reason for rejecting this appointment (customer will be notified):" : "Optional admin note:") || "").trim() : "";
    if (action === "reject" && !reason) return;
    setReviewing(booking.id);
    try {
      const result = await api(`/api/bookings/${encodeURIComponent(booking.id)}/review`, { method: "POST", body: JSON.stringify({ action, reason }) });
      const completedMessage = { approve: "Appointment confirmed and customer notified.", reject: "Appointment rejected and customer notified.", cancel: "Appointment cancelled and customer notified.", reschedule: "Appointment marked for rescheduling; the customer was asked for a new time." }[action];
      setPolicyMessage(result.notificationError ? `Status updated, but WhatsApp notice failed: ${result.notificationError}` : completedMessage);
      setRefreshKey((value) => value + 1);
    } catch (cause) { setError(cause.message || "Could not review appointment."); }
    finally { setReviewing(""); }
  };

  const retryNotification = async (job) => {
    setReviewing(job.id);
    try {
      await api(`/api/notifications/${encodeURIComponent(job.id)}/retry`, { method: "POST", body: JSON.stringify({}) });
      setPolicyMessage("Notification queued for retry.");
      reloadNotifications();
    } catch (cause) { setError(cause.message || "Could not retry notification."); }
    finally { setReviewing(""); }
  };

  useEffect(() => {
    let alive = true;
    const load = async (initial = false) => {
      if (initial && !hasLoaded) setLoading(true);
      try {
        const result = await api("/api/bookings");
        if (!alive) return;
        setBookings(Array.isArray(result.bookings) ? result.bookings : []);
        setError("");
        setHasLoaded(true);
      } catch (cause) {
        if (alive) setError(cause.message || "Could not load bookings.");
      } finally {
        if (alive) setLoading(false);
      }
    };
    load(true);
    const timer = setInterval(() => load(false), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshKey]);

  const confirmedCount = bookings.filter((booking) => booking.status === "confirmed" || booking.status === "booked").length;
  const pendingReviewCount = bookings.filter((booking) => booking.status === "pending_review").length;
  const deliveryProblems = (notificationData.notifications || []).filter((job) => ["failed", "dead"].includes(job.status));
  const upcomingBookings = bookings
    .filter((booking) => ["confirmed", "booked"].includes(booking.status) && new Date(booking.start || 0).getTime() >= Date.now())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 5);
  return (
    <div className="page-stack bookings-page">
      {isAdmin && pendingReviewCount > 0 && <div className="booking-error" role="status"><Clock3 size={16} /><span>{pendingReviewCount} appointment{pendingReviewCount === 1 ? "" : "s"} need admin review.</span></div>}
      {isAdmin && deliveryProblems.length > 0 && <section className="panel"><PanelTitle icon={Bell} title="Notification delivery issues" /><div className="simple-list">{deliveryProblems.slice(0, 10).map((job) => <div key={job.id}><strong>{notificationJobLabel(job)} · {job.status}</strong><small>{job.last_error || "Delivery failed."} · {job.attempts} attempt(s)</small>{job.status === "dead" && <button className="ghost" disabled={reviewing === job.id} onClick={() => retryNotification(job)}>{reviewing === job.id ? "Queueing…" : "Retry"}</button>}</div>)}</div></section>}
      {readiness && !readiness.active && <section className="booking-readiness" role="status">
        <div className="booking-readiness-icon"><ShieldCheck size={19} /></div>
        <div className="booking-readiness-copy">
          <strong>Calendar booking is not enabled</strong>
          <span>Appointments are paused until REFAL's calendar access and booking rules are ready.</span>
          <div className="booking-readiness-tags">
            <span className={readiness.calendarCredentials ? "ready" : "missing"}>{readiness.calendarCredentials ? "Worker credentials configured" : "REFAL worker authorization missing"}</span>
            <span className={readiness.calendarAccessVerified ? "ready" : "missing"}>{readiness.calendarAccessVerified ? `Calendar access verified ${formatDate(readiness.calendarAccessCheckedAt)}` : "Calendar access not verified"}</span>
            <span className={readiness.policy?.durationOwnerConfirmed && readiness.policy.durationMinutes ? "ready" : "missing"}>{readiness.policy?.durationOwnerConfirmed ? `Duration ${readiness.policy.durationMinutes} min` : "Confirmed duration required"}</span>
            <span className={readiness.policy?.minimumNoticeHours != null ? "ready" : "missing"}>{readiness.policy?.minimumNoticeHours != null ? "Booking notice set" : "Minimum notice not set"}</span>
            <span className={readiness.policy?.reminderHours?.length ? "ready" : "missing"}>{readiness.policy?.reminderHours?.length ? "Reminder schedule set" : "Reminder schedule not set"}</span>
          </div>
          <small>Your personal Google Calendar connection does not authorize the WhatsApp worker. Configure worker credentials, then test access here before relying on calendar bookings.</small>
        </div>
      </section>}
      {isAdmin && policy && <section className="panel booking-policy" id="booking-policy">
        <PanelTitle icon={Settings} title="Booking policy" />
        <p className="booking-policy-intro">Rules are stored in Supabase. Google credentials remain in the server secret store.</p>
        <div className="form-grid">
          <label className="field">Calendar ID<input value={policy.calendarId || ""} onChange={(event) => setPolicy({ ...policy, calendarId: event.target.value })} /></label>
          <label className="field">Time zone<input value={policy.timezone || ""} onChange={(event) => setPolicy({ ...policy, timezone: event.target.value })} /></label>
          <label className="field">Start time<input type="time" value={policy.startTime || ""} onChange={(event) => setPolicy({ ...policy, startTime: event.target.value })} /></label>
          <label className="field">End time<input type="time" value={policy.endTime || ""} onChange={(event) => setPolicy({ ...policy, endTime: event.target.value })} /></label>
          <label className="field">Appointment duration (minutes)<input type="number" min="1" max="240" placeholder="Not set" value={policy.durationMinutes ?? ""} onChange={(event) => setPolicy({ ...policy, durationMinutes: event.target.value, durationOwnerConfirmed: false })} /></label>
          <label className="field">Minimum notice (hours)<input type="number" min="0" max="8760" placeholder="Not set" value={policy.minimumNoticeHours ?? ""} onChange={(event) => setPolicy({ ...policy, minimumNoticeHours: event.target.value })} /></label>
          <label className="field">Reminder offsets (hours, comma separated)<input placeholder="Not set" value={(policy.reminderHours || []).join(", ")} onChange={(event) => setPolicy({ ...policy, reminderHours: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label>
          <fieldset className="booking-days"><legend>Available weekdays</legend>{[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"]].map(([day,label]) => <label key={day}><input type="checkbox" checked={(policy.weekdays || []).includes(day)} onChange={(event) => setPolicy({ ...policy, weekdays: event.target.checked ? [...policy.weekdays, day] : policy.weekdays.filter((item) => item !== day) })} />{label}</label>)}</fieldset>
          <label className="booking-confirm-duration"><input type="checkbox" checked={Boolean(policy.durationOwnerConfirmed)} disabled={!policy.durationMinutes} onChange={(event) => setPolicy({ ...policy, durationOwnerConfirmed: event.target.checked })} /> I confirm this appointment duration</label>
          <label className="booking-confirm-duration"><input type="checkbox" checked={Boolean(policy.createMeetLink)} onChange={(event) => setPolicy({ ...policy, createMeetLink: event.target.checked })} /> Create and send Google Meet link for confirmed bookings</label>
        </div>
        <div className="booking-policy-actions">
          <button className="primary" onClick={savePolicy} disabled={policyBusy}><Save size={15} />{policyBusy ? "Saving" : "Save policy"}</button>
          <button className="ghost" onClick={testCalendarAccess} disabled={calendarTestBusy}><RefreshCcw size={14} />{calendarTestBusy ? "Testing access" : "Test calendar access"}</button>
          {policyMessage && <span role="status">{policyMessage}</span>}
          {calendarTestMessage && <span className={calendarTestError ? "calendar-check-error" : "calendar-check-success"} role={calendarTestError ? "alert" : "status"}>{calendarTestMessage}</span>}
        </div>
      </section>}
      {bookings.length > 0 && <section className="lead-command booking-summary-strip">
        <MiniStat icon={CalendarClock} label="Bookings" value={bookings.length} />
        <MiniStat icon={CheckCircle2} label="Confirmed" value={confirmedCount} />
        <div className="lead-command-copy">
          <strong>Booking overview</strong>
          <span>{confirmedCount} confirmed · {bookings.filter((booking) => booking.status === "pending_review").length} awaiting admin review</span>
        </div>
      </section>}
      {upcomingBookings.length > 0 && <section className="panel bookings-upcoming">
        <PanelTitle icon={CalendarClock} title="Upcoming appointments" action={<span className="badge online">{upcomingBookings.length} next</span>} />
        <ul className="booking-upcoming-list">{upcomingBookings.map((booking, index) => {
          const safeMeetUrl = getSafeMeetUrl(booking.meetUrl);
          return <li key={booking.id || `${booking.userId || booking.phone}-${booking.start}-${index}`}>
          <span className="booking-upcoming-icon"><Clock3 size={15} /></span>
          <span className="booking-upcoming-contact"><strong>{booking.name || booking.phone || booking.userId || "REFAL contact"}</strong><small>{booking.purpose || "Appointment"}</small></span>
          <span className="booking-upcoming-meta"><time dateTime={booking.start}>{formatAppointmentTime(booking.start, booking.timezone)}</time>{safeMeetUrl && <a href={safeMeetUrl} target="_blank" rel="noopener noreferrer">Meet</a>}</span>
        </li>;})}</ul>
      </section>}
      {loading && !hasLoaded ? <section className="panel booking-loading"><Loading label="Loading appointments" /></section> : bookings.length === 0 && !error ? (
        <section className="booking-empty-state">
          <span className="booking-empty-icon"><CalendarClock size={24} /></span>
          <div className="booking-empty-copy">
            <span className={readiness?.active ? "booking-state ready" : "booking-state paused"}>{readiness?.active ? "READY FOR BOOKINGS" : "BOOKING SETUP INCOMPLETE"}</span>
            <h2>No appointments yet</h2>
            <p>{readiness?.active
              ? "New appointments will appear here after a customer confirms a time with REFAL."
              : "REFAL will accept appointment requests once calendar access and the required booking rules are configured."}</p>
          </div>
          <button className="booking-empty-action" type="button" onClick={() => document.getElementById("booking-policy")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Review setup <ArrowUpRight size={15} />
          </button>
        </section>
      ) : <section className="panel bookings-records">
        <PanelTitle icon={CalendarClock} title="Calendar bookings" />
        {error && <div className="booking-error" role="alert">
          <span>{hasLoaded ? `Could not refresh bookings: ${error}` : `Could not load bookings: ${error}`}</span>
          <button className="icon-button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="Retry loading bookings" title="Retry"><RefreshCcw size={16} /></button>
        </div>}
        {bookings.length > 0 && <div className="booking-record-list">
          {bookings.map((booking, index) => {
            const start = formatAppointmentTime(booking.start, booking.timezone);
            const end = formatAppointmentTime(booking.end, booking.timezone);
            const safeEventUrl = getSafeEventUrl(booking.eventUrl);
            const safeMeetUrl = getSafeMeetUrl(booking.meetUrl);
            const pending = ["pending_review", "pending_calendar"].includes(booking.status);
            const purpose = String(booking.purpose || "").trim();
            const purposeMissing = !purpose || purpose.toLowerCase() === "business meeting";
            const contactName = booking.name || (booking.phone === "Number hidden by WhatsApp" ? "WhatsApp contact" : booking.phone) || booking.userId || "Unknown contact";
            const identityDetail = booking.phone === "Number hidden by WhatsApp"
              ? `Number hidden by WhatsApp · ${booking.userId || "WhatsApp contact ID unavailable"}`
              : booking.phone;
            return <article className={`booking-record${pending ? " is-pending" : ""}`} key={booking.id || `${booking.userId || booking.phone || "booking"}-${booking.eventId || booking.bookedAt || index}`}>
              <header className="booking-record-head">
                <div className="booking-record-person"><span className="booking-record-avatar"><UserRound size={17} /></span><span><strong>{contactName}</strong>{booking.name && identityDetail && <small>{identityDetail}</small>}{!booking.name && booking.phone === "Number hidden by WhatsApp" && <small>{identityDetail}</small>}</span></div>
              <LeadBadge tier={bookingStatusTone(booking.status)} label={booking.status === "pending_review" ? "Pending review" : pending ? "Awaiting calendar" : bookingStatusLabel(booking.status)} />
              </header>
              <div className="booking-record-main">
                <div className="booking-record-when"><CalendarClock size={17} /><span><strong>{start || formatDate(booking.bookedAt)}</strong>{end && <small>{end} · {booking.timezone}</small>}</span></div>
                <div className={`booking-record-purpose${purposeMissing ? " is-missing" : ""}`}><small>MEETING PURPOSE</small><p>{purposeMissing ? "Purpose not provided" : purpose}</p>{purposeMissing && <span>Ask the customer before confirming.</span>}</div>
              </div>
              {pending && <div className="booking-pending-note"><Clock3 size={16} /><span><strong>{booking.status === "pending_review" ? "Waiting for Refalco Group review" : "Waiting for Google Calendar"}</strong><small>{booking.status === "pending_review" ? "The customer agreed to this time. It is not confirmed until an admin approves it." : "The booking is saved, but Google has not confirmed it yet."}</small></span></div>}
              {isAdmin && booking.status === "pending_review" && <div className="booking-policy-actions"><button className="primary" disabled={reviewing === booking.id} onClick={() => reviewAppointment(booking, "approve")}>{reviewing === booking.id ? "Saving…" : "Approve and confirm"}</button><button className="ghost" disabled={reviewing === booking.id} onClick={() => reviewAppointment(booking, "reject")}>Reject and request another time</button></div>}
              {isAdmin && booking.status === "confirmed" && <div className="booking-policy-actions"><button className="ghost" disabled={reviewing === booking.id} onClick={() => reviewAppointment(booking, "reschedule")}>Reschedule</button><button className="ghost" disabled={reviewing === booking.id} onClick={() => reviewAppointment(booking, "cancel")}>Cancel appointment</button></div>}
              {booking.status === "rejected" && booking.reviewReason && <p className="booking-muted">Admin review note: {booking.reviewReason}</p>}
              <footer className="booking-record-meta">
                <span><small>CALENDAR</small>{safeEventUrl ? <a className="booking-event-link" href={safeEventUrl} target="_blank" rel="noopener noreferrer">Open event <ArrowUpRight size={13} /></a> : <span className="booking-muted">{pending ? "Not added yet" : "Not linked"}</span>}</span>
                <span><small>MEETING LINK</small>{safeMeetUrl ? <a className="booking-event-link" href={safeMeetUrl} target="_blank" rel="noopener noreferrer">Join Google Meet <ArrowUpRight size={13} /></a> : <span className="booking-muted">{pending ? "Available after confirmation" : "Not created"}</span>}</span>
                <span><small>REMINDERS</small><ReminderSummary reminders={booking.reminders} pending={pending} /></span>
              </footer>
            </article>;
          })}
        </div>}
      </section>}
    </div>
  );
}

function ReminderSummary({ reminders, pending = false }) {
  if (!Array.isArray(reminders) || reminders.length === 0) return <span className="booking-muted">{pending ? "After confirmation" : "None scheduled"}</span>;
  return <div className="booking-reminders">{reminders.map((reminder, index) => (
    <div className="booking-reminder" key={`${reminder.dueAt || "reminder"}-${index}`}>
      <LeadBadge tier={reminder.status === "sent" ? "online" : reminder.status === "failed" ? "hot" : "cold"} label={reminder.status || "scheduled"} />
      <small>{reminder.sentAt ? `Sent ${formatDate(reminder.sentAt)}` : reminder.dueAt ? `Due ${formatDate(reminder.dueAt)}` : "Time not set"}</small>
      {reminder.lastError && <small className="booking-reminder-error" title={reminder.lastError}>{reminder.lastError}</small>}
    </div>
  ))}</div>;
}

function bookingStatusLabel(status) {
  const labels = { pending_review: "Pending review", pending_calendar: "Pending calendar", confirmed: "Confirmed", rejected: "Rejected", rescheduled: "Rescheduled", cancelled: "Cancelled", completed: "Completed", failed: "Failed", booked: "Booked" };
  return labels[status] || status || "Unknown";
}

function bookingStatusTone(status) {
  if (status === "confirmed" || status === "booked" || status === "completed") return "online";
  if (status === "failed" || status === "cancelled" || status === "rejected") return "hot";
  return "cold";
}

function formatAppointmentTime(value, timezone) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not available";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timezone ? { timeZone: timezone } : {})
    }).format(date);
  } catch {
    return formatDate(value);
  }
}

function getSafeEventUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function getSafeMeetUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "meet.google.com" ? url.href : "";
  } catch {
    return "";
  }
}

function Metric({ icon: Icon, title, value, label }) {
  return (
    <div className="metric">
      <span className="metric-icon"><Icon size={17} /></span>
      <span className="metric-title">{title}</span>
      <strong>{Number(value || 0).toLocaleString()}</strong>
      <small>{label}</small>
    </div>
  );
}

function MiniStat({ icon: Icon, label, value }) {
  return (
    <div className="mini-stat">
      <Icon size={17} />
      <span>{label}</span>
      <strong>{value ?? 0}</strong>
    </div>
  );
}

function PanelTitle({ icon: Icon, title, action }) {
  return (
    <div className="panel-title">
      <h2><Icon size={18} /> {title}</h2>
      {action}
    </div>
  );
}

function LeadBadge({ tier, label }) {
  return <span className={`badge ${tier || "cold"}`}>{label || tier || "cold"}</span>;
}

function SimpleList({ items, empty, render }) {
  if (!items.length) return <p className="empty">{empty}</p>;
  return <div className="simple-list">{items.map((item, index) => <div key={index}>{render(item)}</div>)}</div>;
}

function Loading({ label = "Loading" }) {
  return <div className="loading"><span />{label}</div>;
}

const apiGetCache = new Map();
const apiGetInFlight = new Map();
const API_GET_CACHE_MS = 12000;

function clearApiCache() {
  apiGetCache.clear();
  apiGetInFlight.clear();
}

function getCachedApiResponse(url) {
  const entry = apiGetCache.get(url);
  if (!entry || entry.expiresAt <= Date.now()) {
    apiGetCache.delete(url);
    return null;
  }
  return entry.data;
}

function useApi(url, deps = [], options = {}) {
  const cachedData = getCachedApiResponse(url);
  const [data, setData] = useState(() => cachedData ?? {});
  const [loading, setLoading] = useState(() => cachedData === null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = (showLoading) => {
      if (showLoading && getCachedApiResponse(url) === null) setLoading(true);
      api(url)
        .then((result) => {
          if (alive) {
            setData(result);
            setError("");
          }
        })
        .catch((cause) => { if (alive) setError(cause.message || "Could not load this data."); })
        .finally(() => {
          if (alive && showLoading) setLoading(false);
        });
    };
    load(true);
    const timer = options.pollMs ? setInterval(() => load(false), options.pollMs) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [url, tick, options.pollMs, ...deps]);

  return { data, setData, loading, error, reload: () => setTick((value) => value + 1) };
}

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const cached = getCachedApiResponse(url);
    if (cached !== null) return cached;
    const pending = apiGetInFlight.get(url);
    if (pending) return pending;
  }

  const request = (async () => {
    const response = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
    if (method === "GET") apiGetCache.set(url, { data: body, expiresAt: Date.now() + API_GET_CACHE_MS });
    else apiGetCache.clear();
    return body;
  })();

  if (method !== "GET") return request;
  apiGetInFlight.set(url, request);
  try {
    return await request;
  } finally {
    if (apiGetInFlight.get(url) === request) apiGetInFlight.delete(url);
  }
}

function formatDate(value) {
  if (!value) return "not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "not available";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function initials(value) {
  const text = String(value || "RA").replace(/[^\p{L}\p{N}\s+]/gu, " ").trim();
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length) return "RA";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function titleFromMessage(value) {
  const title = String(value || "Memory").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 56) : "Memory";
}

createRoot(document.getElementById("root")).render(<App />);
