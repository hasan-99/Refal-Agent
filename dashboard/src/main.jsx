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
  ClipboardList,
  Clock3,
  Database,
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
import { formatUsageUsd } from "./usageDisplay.js";
import { COMPANY_IDENTITY_CHANGE_REASONS } from "../companyIdentity.js";
import KnowledgeCommercialWarning from "./KnowledgeCommercialWarning.jsx";
import rafaLogo from "./assets/rafa-mark.png";
const Conversations = React.lazy(() => import("./Conversations.jsx"));
const Performance = React.lazy(() => import("./Performance.jsx"));
const HandoverInbox = React.lazy(() => import("./HandoverInbox.jsx"));
const FactRegister = React.lazy(() => import("./FactRegister.jsx"));
const DynamicData = React.lazy(() => import("./DynamicData.jsx"));

const navItems = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "agent-status", label: "Agent status", icon: Activity },
  { id: "performance", label: "Performance", icon: TrendingUp },
  { id: "conversations", label: "Conversations", icon: MessageCircleMore },
  { id: "company-brain", label: "Company brain", icon: BrainCircuit },
  { id: "bookings", label: "Bookings", icon: CalendarClock },
  { id: "follow-ups", label: "Follow-ups", icon: Bell, adminOnly: true },
  { id: "blocked", label: "Blocked numbers", icon: ShieldBan, adminOnly: true }
];

const DASHBOARD_SECTION_STORAGE_KEY = "rafa-dashboard-active-section";
const DASHBOARD_CONVERSATION_VIEW_STORAGE_KEY = "rafa-dashboard-conversation-view";
const DASHBOARD_CONVERSATION_ID_STORAGE_KEY = "rafa-dashboard-conversation-id";
const legacyBrainSections = new Set(["knowledge", "identity", "facts", "commercial-data", "response-style"]);
const dashboardSections = new Set([...navItems.map((item) => item.id), ...legacyBrainSections, "account", "team", "audit"]);

function initialDashboardSection() {
  const section = readInitialValue("section", DASHBOARD_SECTION_STORAGE_KEY, dashboardSections, "overview");
  return legacyBrainSections.has(section) ? "company-brain" : section;
}

function initialBrainCategory() {
  try {
    const params = new URL(window.location.href).searchParams;
    const section = params.get("section");
    if (legacyBrainSections.has(section)) return section;
    const category = params.get("category");
    return ["knowledge", "identity", "facts", "commercial-data", "response-style", "business-guidance"].includes(category) ? category : "knowledge";
  } catch {
    return "knowledge";
  }
}

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
  const [active, setActive] = useState(initialDashboardSection);
  const [brainCategory, setBrainCategory] = useState(initialBrainCategory);
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
    if (authState?.authenticated && authState.role !== "admin" && ["team", "follow-ups", "blocked"].includes(active)) setActive("overview");
    if (authState?.authenticated && authState.role !== "admin" && ["facts", "commercial-data"].includes(brainCategory)) setBrainCategory("knowledge");
  }, [active, authState?.role, brainCategory]);

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
    if (active === "company-brain") url.searchParams.set("category", brainCategory);
    else url.searchParams.delete("category");
    if (active === "conversations") url.searchParams.set("view", conversationView);
    else url.searchParams.delete("view");
    if (active === "conversations" && selectedConversationId) url.searchParams.set("conversation", selectedConversationId);
    else url.searchParams.delete("conversation");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [active, authState?.authenticated, brainCategory, conversationView, selectedConversationId]);

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
    if (legacyBrainSections.has(section)) {
      setBrainCategory(section);
      setActive("company-brain");
      return;
    }
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
    (active === "audit" && isAdmin ? { id: "audit", label: "Admin audit", icon: ClipboardList } : null) ||
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
            {isAdmin && <button className="sidebar-menu-action" type="button" onClick={() => { setActive("audit"); setSidebarSettingsOpen(false); }}><ClipboardList size={16} /><span>Admin audit</span><ChevronRight size={14} /></button>}
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
        {active === "company-brain" && <CompanyBrain isAdmin={isAdmin} category={brainCategory} onCategoryChange={setBrainCategory} onNavigate={navigateTo} />}
        {active === "bookings" && <Bookings isAdmin={isAdmin} />}
        {active === "follow-ups" && isAdmin && <React.Suspense fallback={<Loading label="Loading specialist follow-ups" />}><HandoverInbox onNavigate={navigateTo} /></React.Suspense>}
        {active === "blocked" && isAdmin && <BlockedNumbers />}
        {active === "account" && <AccountDetails authState={authState} />}
        {active === "team" && isAdmin && <Team />}
        {active === "audit" && (isAdmin ? <AdminAudit /> : <Overview onNavigate={navigateTo} isAdmin={isAdmin} />)}
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

function AdminAudit() {
  const { data, loading, error, reload } = useApi("/api/admin/audit");
  const auditEvents = Array.isArray(data.databaseAuditEvents) ? data.databaseAuditEvents : [];
  const adminEvents = Array.isArray(data.events) ? data.events : [];
  return <div className="page-stack admin-audit-page">
    <section className="team-intro">
      <div><span className="eyebrow"><ClipboardList size={14} /> CHANGE HISTORY</span><h2>Admin audit</h2><p>Review company-data and workflow changes. Private message content and contact identifiers are filtered from this view.</p></div>
      <button className="ghost icon-button" type="button" onClick={reload} aria-label="Refresh admin audit" title="Refresh"><RefreshCcw size={16} /></button>
    </section>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel admin-audit-panel" aria-labelledby="database-audit-title">
      <div className="team-table-heading"><div><h2 id="database-audit-title">Workflow and record changes</h2><p>Latest database audit events · read only</p></div><span className="badge">{auditEvents.length} events</span></div>
      {loading ? <Loading label="Loading audit history" /> : auditEvents.length ? <div className="admin-audit-list">{auditEvents.map((event) => <article className="admin-audit-event" key={event.id}>
        <div className="admin-audit-event-heading"><strong>{event.event.replaceAll("_", " ")}</strong><time dateTime={event.at}>{formatDate(event.at)}</time></div>
        <p><span>{event.source}</span><span>Actor: {event.actorType}</span></p>
        {Object.keys(event.details || {}).length > 0 && <details><summary>Safe audit fields</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>}
      </article>)}</div> : <p className="empty">No workflow changes have been recorded yet.</p>}
    </section>
    <section className="panel admin-audit-panel" aria-labelledby="dashboard-audit-title">
      <div className="team-table-heading"><div><h2 id="dashboard-audit-title">Dashboard admin actions</h2><p>Access, memory, qualification, reply edits, and business guidance changes</p></div><span className="badge">{adminEvents.length} events</span></div>
    {adminEvents.length ? <div className="table-scroll"><table><thead><tr><th>Action</th><th>Actor</th><th>Fields</th><th>When</th></tr></thead><tbody>{adminEvents.map((event, index) => <tr key={`${event.event}-${event.at}-${index}`}><td>{event.action.replaceAll("_", " ")}</td><td>{event.actor}</td><td>{event.fields.map((field) => field.replaceAll("_", " ")).join(", ") || "—"}</td><td>{formatDate(event.at)}</td></tr>)}</tbody></table></div> : <p className="empty">No dashboard admin actions have been recorded yet.</p>}
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
  const [deletingSessionId, setDeletingSessionId] = useState("");
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

  async function deleteSession(session) {
    const sessionId = String(session?.id || "");
    if (!sessionId) return;
    const title = String(session.title || "New chat");
    if (typeof window.confirm === "function" && !window.confirm(`Delete “${title}” and its chat messages? Saved memories are managed separately.`)) return;
    setError("");
    setDeletingSessionId(sessionId);
    try {
      await api(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      const next = await api("/api/agent/state");
      setState(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingSessionId("");
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
              <div
                key={session.id}
                className={state.session?.id === session.id ? "session-item active" : "session-item"}
              >
                <button type="button" className="session-item-open" onClick={() => openSession(session.id)} disabled={deletingSessionId === session.id}>
                  <span>{session.title}</span>
                  <small>{formatDate(session.updated_at)}</small>
                </button>
                <button type="button" className="session-item-delete" onClick={() => void deleteSession(session)} disabled={Boolean(deletingSessionId)} aria-label={`Delete chat ${session.title || "New chat"}`} title="Delete chat">
                  {deletingSessionId === session.id ? <span className="conversation-spinner" aria-label="Deleting chat" /> : <Trash2 size={14} />}
                </button>
              </div>
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

function CompanyBrain({ isAdmin, category, onCategoryChange, onNavigate }) {
  const [openKnowledgeCreate, setOpenKnowledgeCreate] = useState(false);
  function startKnowledgeCreate() {
    setOpenKnowledgeCreate(true);
    onCategoryChange("knowledge");
  }
  const categories = [
    { id: "knowledge", label: "Knowledge library", description: "Company service and guidance material", icon: BookOpenCheck },
    ...(isAdmin ? [
      { id: "identity", label: "Company identity", description: "Configured identity and operating footprint", icon: Building2 },
      { id: "facts", label: "Verified facts", description: "Evidence, review status, and freshness", icon: ShieldCheck },
      { id: "commercial-data", label: "Services and commercial data", description: "Typed offers, fees, property, and terms", icon: Database },
      { id: "response-style", label: "Response style", description: "Formatting, next steps, and service suggestions", icon: Settings },
      { id: "business-guidance", label: "Business rules & hooks", description: "Editable guidance and localized conversation cues", icon: ClipboardList }
    ] : [])
  ];
  const activeCategory = categories.some((item) => item.id === category) ? category : "knowledge";
  return <div className="page-stack company-brain-page">
    <section className="company-brain-intro">
      <div><span className="eyebrow"><BrainCircuit size={14} /> REFAL KNOWLEDGE AND COMPANY DATA</span><h2>Company brain</h2><p>Manage the existing records REFAL uses to answer company questions. Each category keeps its own review and audit controls.</p></div>
      <button type="button" className="ghost" onClick={() => onNavigate("bookings")}>Open appointment rules <ArrowUpRight size={14} /></button>
    </section>
    <nav className="company-brain-categories" aria-label="Company brain categories" role="tablist">
      {categories.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" role="tab" aria-selected={activeCategory === item.id} className={activeCategory === item.id ? "active" : ""} onClick={() => onCategoryChange(item.id)}><Icon size={17} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight size={15} /></button>; })}
    </nav>
    <div role="tabpanel" aria-label={categories.find((item) => item.id === activeCategory)?.label}>
      {activeCategory === "knowledge" && <Knowledge isAdmin={isAdmin} onNavigate={onNavigate} openCreateRequest={openKnowledgeCreate} onCreateRequestHandled={() => setOpenKnowledgeCreate(false)} />}
      {activeCategory === "identity" && isAdmin && <CompanyIdentity />}
      {activeCategory === "facts" && isAdmin && <React.Suspense fallback={<Loading label="Loading the fact register" />}><FactRegister isAdmin={isAdmin} onAddKnowledge={startKnowledgeCreate} /></React.Suspense>}
      {activeCategory === "commercial-data" && isAdmin && <React.Suspense fallback={<Loading label="Loading commercial data" />}><DynamicData isAdmin={isAdmin} /></React.Suspense>}
      {activeCategory === "response-style" && isAdmin && <ResponseStyleSettings />}
      {activeCategory === "business-guidance" && isAdmin && <BusinessGuidanceSettings />}
    </div>
  </div>;
}

function CompanyIdentity() {
  const { data, loading, error, reload } = useApi("/api/company/identity");
  const [identity, setIdentity] = useState(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { if (data.identity) setIdentity(data.identity); }, [data.identity]);
  if (loading && !identity) return <Loading label="Loading company identity" />;
  if (error && !identity) return <section className="panel company-identity-panel" role="alert"><PanelTitle icon={Building2} title="Company identity" /><p className="booking-policy-intro">The saved company identity could not be loaded.</p><p className="inline-error">{error}</p><button type="button" className="ghost" onClick={reload}><RefreshCcw size={15} /> Retry</button></section>;
  if (!identity) return null;

  async function saveIdentity(event) {
    event.preventDefault();
    setSaving(true); setSaveError(""); setMessage("");
    const list = (value) => (Array.isArray(value) ? value : String(value || "").split(/\r?\n/u)).map((entry) => entry.trim()).filter(Boolean);
    try {
      const next = { ...identity, cities: list(identity.cities), departments: list(identity.departments), languages: list(identity.languages) };
      const result = await api("/api/company/identity", { method: "PUT", body: JSON.stringify({ identity: next, reason }) });
      setIdentity(result.identity); setEditing(false); setReason("");
      setMessage(result.changedFields?.length ? `Saved ${result.changedFields.length} changed ${result.changedFields.length === 1 ? "field" : "fields"}. New replies use the updated identity.` : "Company identity is unchanged.");
      reload();
    } catch (cause) { setSaveError(cause.message || "Could not save company identity."); }
    finally { setSaving(false); }
  }

  function changeIdentity(field, value) { setIdentity((current) => ({ ...current, [field]: value })); setSaveError(""); setMessage(""); }

  const languageNames = new Intl.DisplayNames(undefined, { type: "language" });
  const displayList = (value) => (Array.isArray(value) ? value : String(value || "").split(/\r?\n/u).filter(Boolean));
  const rows = [
    ["Brand", identity.brand],
    ["Group", identity.groupName],
    ["Legal name", identity.legalName],
    ["Jurisdiction", identity.jurisdiction],
    ["Timezone", identity.timezone],
    ["Languages", displayList(identity.languages).map((language) => languageNames.of(language)).join(", ")],
    ["Cities", displayList(identity.cities).join(", ")],
    ["Departments", displayList(identity.departments).join(", ")]
  ];
  return <section className="panel company-identity-panel">
    <PanelTitle icon={Building2} title="Company identity" action={!editing && <button type="button" className="ghost" onClick={() => { setEditing(true); setMessage(""); }}>Edit identity</button>} />
    <p className="booking-policy-intro">Manage the identity Rafa uses across WhatsApp and the dashboard Agent. Credibility figures and company claims stay in reviewed facts and approved knowledge.</p>
    {message && <p className="success-message" role="status">{message}</p>}
    {error && identity && <p className="inline-error" role="status">The saved identity could not be refreshed. The last saved values remain visible; retry before making another change.</p>}
    {editing ? <form className="company-identity-form" onSubmit={saveIdentity}>
      <label className="field">Brand<input value={identity.brand} maxLength={120} required onChange={(event) => changeIdentity("brand", event.target.value)} /></label>
      <label className="field">Group name<input value={identity.groupName} maxLength={120} required onChange={(event) => changeIdentity("groupName", event.target.value)} /></label>
      <label className="field">Legal name<input value={identity.legalName} maxLength={120} required onChange={(event) => changeIdentity("legalName", event.target.value)} /></label>
      <label className="field">Jurisdiction<input value={identity.jurisdiction} maxLength={120} required onChange={(event) => changeIdentity("jurisdiction", event.target.value)} /></label>
      <label className="field">Timezone<input value={identity.timezone} maxLength={120} required aria-describedby="company-identity-timezone-help" onChange={(event) => changeIdentity("timezone", event.target.value)} /><small id="company-identity-timezone-help">Use an IANA timezone, for example Europe/Nicosia.</small></label>
      <label className="field">Cities<textarea value={displayList(identity.cities).join("\n")} rows={4} required onChange={(event) => changeIdentity("cities", event.target.value)} /><small>One city per line.</small></label>
      <label className="field">Departments<textarea value={displayList(identity.departments).join("\n")} rows={5} required onChange={(event) => changeIdentity("departments", event.target.value)} /><small>One department per line.</small></label>
      <label className="field">Languages<textarea value={displayList(identity.languages).join("\n")} rows={3} required aria-describedby="company-identity-languages-help" onChange={(event) => changeIdentity("languages", event.target.value)} /><small id="company-identity-languages-help">Use supported language codes: ar, en, el. One per line.</small></label>
      <label className="field company-identity-reason">Reason for change<select value={reason} required onChange={(event) => setReason(event.target.value)}><option value="">Choose a reason</option>{COMPANY_IDENTITY_CHANGE_REASONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      <div className="form-actions"><button className="primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save identity"}</button><button type="button" className="ghost" disabled={saving} onClick={() => { setIdentity(data.identity); setEditing(false); setReason(""); setSaveError(""); }}>Cancel</button></div>
    </form> : <dl className="company-identity-grid">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not configured"}</dd></div>)}</dl>}
    <p className="company-identity-source">The validated <code>config/company-profile.json</code> remains the startup fallback. Dashboard changes are stored in Supabase and consumed by both answer runtimes. Credibility figures remain in Verified facts and cannot be changed here.</p>
  </section>;
}

function ResponseStyleSettings() {
  const defaults = { paragraphLength: "short", listMarker: "hyphen", boldLabels: true, continuationStyle: "adaptive", allowRelevantServiceSuggestions: true };
  const { data, loading, error: loadError, reload } = useApi("/api/settings/response-style");
  const [style, setStyle] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (data.style) setStyle({ ...defaults, ...data.style });
  }, [data.style]);

  async function save(event) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const result = await api("/api/settings/response-style", { method: "PUT", body: JSON.stringify({ style }) });
      setStyle({ ...defaults, ...result.style }); setMessage("Response style saved to Supabase and will be used on new replies."); reload();
    } catch (cause) { setError(cause.message || "Could not save response style."); }
    finally { setBusy(false); }
  }

  if (loading && !data.style) return <Loading label="Loading response style" />;
  if (loadError) return <section className="panel response-style-panel response-style-load-error" role="alert">
    <PanelTitle icon={Settings} title="Rafa response style" />
    <p className="booking-policy-intro">Saved preferences could not be loaded, so the current response style is unavailable.</p>
    <p className="inline-error">{loadError}</p>
    <button type="button" className="ghost" onClick={reload}><RefreshCcw size={15} /> Retry loading</button>
  </section>;
  return <section className="panel response-style-panel">
    <PanelTitle icon={Settings} title="Rafa response style" />
    <p className="booking-policy-intro">Set reply formatting, helpful continuations, and whether Rafa may offer one relevant service suggestion. Suggestions stay optional and require approved evidence; these preferences never override privacy, safety, or appointment rules.</p>
    {loadError && <p className="inline-error" role="alert">{loadError}</p>}
    <form onSubmit={save}>
      <div className="form-grid">
        <label className="field">Paragraph length<select value={style.paragraphLength} onChange={(event) => setStyle({ ...style, paragraphLength: event.target.value })}><option value="short">Short</option><option value="very_short">Very short</option></select></label>
        <label className="field">List marker<select value={style.listMarker} onChange={(event) => setStyle({ ...style, listMarker: event.target.value })}><option value="hyphen">Hyphen bullets</option><option value="numbered">Numbered list</option></select></label>
        <label className="field">How to continue<select value={style.continuationStyle} onChange={(event) => setStyle({ ...style, continuationStyle: event.target.value })}><option value="adaptive">Useful question or next step</option><option value="useful_question">One useful question</option><option value="helpful_next_step">Useful next step</option></select><small>Only add a question or next step when it helps; otherwise finish the answer.</small></label>
        <label className="booking-confirm-duration"><input type="checkbox" checked={style.boldLabels} onChange={(event) => setStyle({ ...style, boldLabels: event.target.checked })} /> Bold short labels when useful</label>
        <label className="response-style-suggestion-control"><input type="checkbox" checked={style.allowRelevantServiceSuggestions} onChange={(event) => setStyle({ ...style, allowRelevantServiceSuggestions: event.target.checked })} /><span><strong>Allow one relevant service suggestion</strong><small>When enabled, Rafa may add at most one optional suggestion after answering, only when approved knowledge supports it and it helps the customer's stated goal.</small></span></label>
      </div>
      <div className="booking-policy-actions"><button className="primary" type="submit" disabled={busy}><Save size={15} />{busy ? "Saving" : "Save response style"}</button>{message && <span role="status">{message}</span>}{error && <span className="calendar-check-error" role="alert">{error}</span>}</div>
    </form>
    <section className="response-style-preview" aria-labelledby="response-style-preview-title" aria-label="Reply formatting preview">
      <div><h3 id="response-style-preview-title">Reply formatting preview</h3><span>Preview only · edits apply after saving</span></div>
      <div className="response-style-preview-message" dir="auto">
        <p>{style.boldLabels ? <><strong>Key detail:</strong> </> : "Key detail: "}One clear point in a short paragraph.</p>
        <p>Separate points stay on their own lines, with space between paragraphs.</p>
        <ul className={style.listMarker === "numbered" ? "numbered" : "hyphen"}>
          <li>First supporting detail</li>
          <li>Second supporting detail</li>
        </ul>
        <p className="response-style-preview-continuation">{style.continuationStyle === "useful_question" ? "One focused question when needed." : style.continuationStyle === "helpful_next_step" ? "A useful next step when it helps." : "A useful question or next step when relevant."}</p>
        <p className="response-style-preview-suggestion" role="status">{style.allowRelevantServiceSuggestions ? "A relevant service suggestion is allowed when helpful and supported by approved knowledge." : "Unsolicited service suggestions are disabled."}</p>
      </div>
    </section>
  </section>;
}

function BusinessGuidanceSettings() {
  const empty = { rules: [], hooks: [] };
  const { data, loading, error: loadError, reload } = useApi("/api/settings/business-guidance");
  const [guidance, setGuidance] = useState(empty);
  const [baseline, setBaseline] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (data.guidance) {
      const saved = { rules: data.guidance.rules || [], hooks: data.guidance.hooks || [] };
      setGuidance(saved);
      setBaseline(JSON.stringify(saved));
    }
  }, [data.guidance]);

  function newId(kind) {
    return `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`}`;
  }
  function updateItem(collection, id, patch) {
    setGuidance((current) => ({ ...current, [collection]: current[collection].map((item) => item.id === id ? { ...item, ...patch } : item) }));
    setMessage(""); setSaveError("");
  }
  function addRule() {
    setGuidance((current) => ({ ...current, rules: [...current.rules, { id: newId("rule"), title: "", language: "all", instruction: "", enabled: true }] }));
    setMessage(""); setSaveError("");
  }
  function addHook() {
    setGuidance((current) => ({ ...current, hooks: [...current.hooks, { id: newId("hook"), title: "", when: "", enabled: true, phrases: { en: "", ar: "", el: "" } }] }));
    setMessage(""); setSaveError("");
  }
  function removeItem(collection, id) {
    setGuidance((current) => ({ ...current, [collection]: current[collection].filter((item) => item.id !== id) }));
    setMessage(""); setSaveError("");
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage(""); setSaveError("");
    try {
      const result = await api("/api/settings/business-guidance", { method: "PUT", body: JSON.stringify({ guidance, reason }) });
      const saved = { rules: result.guidance.rules || [], hooks: result.guidance.hooks || [] };
      setGuidance(saved); setBaseline(JSON.stringify(saved)); setReason(""); setMessage("Business rules and hooks saved. WhatsApp replies use the saved guidance within 30 seconds."); reload();
    } catch (cause) { setSaveError(cause.message || "Could not save business guidance."); }
    finally { setBusy(false); }
  }

  if (loading && !baseline) return <Loading label="Loading business rules and hooks" />;
  if (loadError && !baseline) return <section className="panel business-guidance-panel" role="alert"><PanelTitle icon={ClipboardList} title="Business rules & hooks" /><p className="booking-policy-intro">Saved guidance could not be loaded, so editing is unavailable.</p><p className="inline-error">{loadError}</p><button type="button" className="ghost" onClick={reload}><RefreshCcw size={15} /> Retry loading</button></section>;

  const dirty = baseline !== JSON.stringify(guidance);
  return <section className="panel business-guidance-panel">
    <PanelTitle icon={ClipboardList} title="Business rules & hooks" />
    <p className="booking-policy-intro">Add, edit, enable, or remove business guidance that Rafa uses in live replies. Rules can apply to all languages or one language. Each hook has separate English, Arabic, and Greek wording.</p>
    <div className="business-guidance-boundary"><ShieldCheck size={17} /><p><strong>Safety stays protected.</strong> These are optional business preferences, not company evidence or reply scripts. Approved knowledge still supports company claims; privacy, consent, and booking rules remain enforced.</p></div>
    {loadError && <p className="inline-error" role="status">The last saved values remain visible. Retry before saving further changes.</p>}
    <form onSubmit={save}>
      <div className="business-guidance-section-heading"><div><h3>Business guidance</h3><p>Short instructions for how Rafa handles a company conversation.</p></div><button type="button" className="ghost" onClick={addRule} disabled={guidance.rules.length >= 12}><Plus size={15} /> Add rule</button></div>
      {guidance.rules.length === 0 && <p className="business-guidance-empty">No extra business rules are configured.</p>}
      <div className="business-guidance-list">{guidance.rules.map((rule, index) => <article className="business-guidance-item" key={rule.id}>
        <div className="business-guidance-item-head"><strong>Rule {index + 1}</strong><button type="button" className="business-guidance-remove" aria-label={`Remove rule ${index + 1}`} onClick={() => removeItem("rules", rule.id)}><Trash2 size={15} /> Remove</button></div>
        <div className="form-grid">
          <label className="field">Name<input value={rule.title} maxLength={80} required placeholder="For example: Existing clients" onChange={(event) => updateItem("rules", rule.id, { title: event.target.value })} /></label>
          <label className="field">Applies to<select value={rule.language} onChange={(event) => updateItem("rules", rule.id, { language: event.target.value })}><option value="all">All languages</option><option value="en">English</option><option value="ar">Arabic</option><option value="el">Greek</option></select></label>
          <label className="field business-guidance-wide">Guidance<textarea value={rule.instruction} maxLength={500} rows={3} required placeholder="Describe the preferred handling in a few clear sentences." onChange={(event) => updateItem("rules", rule.id, { instruction: event.target.value })} /></label>
          <label className="business-guidance-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateItem("rules", rule.id, { enabled: event.target.checked })} /> Enabled</label>
        </div>
      </article>)}</div>

      <div className="business-guidance-section-heading"><div><h3>Conversation hooks</h3><p>Optional localized wording ideas. Rafa adapts them to the conversation and never has to use them.</p></div><button type="button" className="ghost" onClick={addHook} disabled={guidance.hooks.length >= 12}><Plus size={15} /> Add hook</button></div>
      {guidance.hooks.length === 0 && <p className="business-guidance-empty">No extra conversation hooks are configured.</p>}
      <div className="business-guidance-list">{guidance.hooks.map((hook, index) => <article className="business-guidance-item" key={hook.id}>
        <div className="business-guidance-item-head"><strong>Hook {index + 1}</strong><button type="button" className="business-guidance-remove" aria-label={`Remove hook ${index + 1}`} onClick={() => removeItem("hooks", hook.id)}><Trash2 size={15} /> Remove</button></div>
        <div className="form-grid">
          <label className="field">Name<input value={hook.title} maxLength={80} required placeholder="For example: Offer a specialist review" onChange={(event) => updateItem("hooks", hook.id, { title: event.target.value })} /></label>
          <label className="field business-guidance-wide">Use only when<textarea value={hook.when} maxLength={200} rows={2} required placeholder="Describe the situation where this may help." onChange={(event) => updateItem("hooks", hook.id, { when: event.target.value })} /></label>
          <label className="field">English<textarea value={hook.phrases.en} maxLength={240} rows={2} required onChange={(event) => updateItem("hooks", hook.id, { phrases: { ...hook.phrases, en: event.target.value } })} /></label>
          <label className="field">العربية<textarea dir="rtl" lang="ar" value={hook.phrases.ar} maxLength={240} rows={2} required onChange={(event) => updateItem("hooks", hook.id, { phrases: { ...hook.phrases, ar: event.target.value } })} /></label>
          <label className="field">Ελληνικά<textarea lang="el" value={hook.phrases.el} maxLength={240} rows={2} required onChange={(event) => updateItem("hooks", hook.id, { phrases: { ...hook.phrases, el: event.target.value } })} /></label>
          <label className="business-guidance-enabled"><input type="checkbox" checked={hook.enabled} onChange={(event) => updateItem("hooks", hook.id, { enabled: event.target.checked })} /> Enabled</label>
        </div>
      </article>)}</div>

      <label className="field business-guidance-reason">Reason for change<select value={reason} required onChange={(event) => setReason(event.target.value)}><option value="">Choose a reason</option><option value="clarify_customer_follow_up">Clarify customer follow-up</option><option value="improve_localized_wording">Improve language-specific wording</option><option value="align_with_approved_process">Align with an approved process</option><option value="remove_outdated_guidance">Remove outdated guidance</option><option value="other_operational_adjustment">Other operational adjustment</option></select></label>
      <div className="booking-policy-actions"><button className="primary" type="submit" disabled={busy || !dirty}><Save size={15} />{busy ? "Saving" : "Save rules & hooks"}</button>{message && <span role="status">{message}</span>}{saveError && <span className="calendar-check-error" role="alert">{saveError}</span>}</div>
    </form>
  </section>;
}

function Knowledge({ isAdmin, onNavigate, openCreateRequest = false, onCreateRequestHandled }) {
  const { data, loading, error: loadError, reload } = useApi("/api/knowledge");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importLanguage, setImportLanguage] = useState("en");
  const [uploadFile, setUploadFile] = useState(null);
  const [knowledgeMode, setKnowledgeMode] = useState("text");
  const [knowledgeView, setKnowledgeView] = useState("content");
  const [editorMode, setEditorMode] = useState("update");
  const [editingDocument, setEditingDocument] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveUndo, setArchiveUndo] = useState(null);
  const [reviewReasons, setReviewReasons] = useState({});
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  const [knowledgeDomain, setKnowledgeDomain] = useState("all");
  const [knowledgeLanguage, setKnowledgeLanguage] = useState("all");
  const [knowledgeStatus, setKnowledgeStatus] = useState("all");

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
  const normalizeSearchText = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const normalizedSearch = normalizeSearchText(knowledgeSearch.trim());
  const knowledgeDomains = [...new Set(documents.map((doc) => String(doc.metadata?.domain || "other").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const knowledgeLanguages = [...new Set(documents.map((doc) => String(doc.language_code || "und").trim().toLowerCase()))].sort((a, b) => a.localeCompare(b));
  const languageName = (language) => {
    if (language === "und") return "Unspecified language";
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(language) || language.toUpperCase(); }
    catch { return language.toUpperCase(); }
  };
  const languageCollator = (language) => {
    try { return new Intl.Collator(language === "und" ? undefined : language, { sensitivity: "base", numeric: true }); }
    catch { return new Intl.Collator(undefined, { sensitivity: "base", numeric: true }); }
  };
  const orderedKnowledgeLanguages = [...knowledgeLanguages].sort((a, b) => languageName(a).localeCompare(languageName(b), "en", { sensitivity: "base" }) || a.localeCompare(b));
  const knowledgeStatuses = [...new Set(documents.map((doc) => String(doc.review_status || "unknown").trim().toLowerCase()))].sort((a, b) => a.localeCompare(b));
  const visibleDocuments = documents.filter((doc) => {
    if (knowledgeDomain !== "all" && (doc.metadata?.domain || "other") !== knowledgeDomain) return false;
    if (knowledgeLanguage !== "all" && String(doc.language_code || "und").trim().toLowerCase() !== knowledgeLanguage) return false;
    if (knowledgeStatus !== "all" && String(doc.review_status || "unknown").trim().toLowerCase() !== knowledgeStatus) return false;
    if (!normalizedSearch) return true;
    const source = sources.find((item) => item.id === doc.source_id);
    return [doc.title, doc.canonical_content, doc.language_code, doc.review_status, source?.display_name, doc.metadata?.topic, doc.metadata?.domain]
      .some((value) => normalizeSearchText(value).includes(normalizedSearch));
  }).sort((a, b) => languageName(String(a.language_code || "und").trim().toLowerCase()).localeCompare(languageName(String(b.language_code || "und").trim().toLowerCase()), "en", { sensitivity: "base" })
    || languageCollator(String(a.language_code || "und").trim().toLowerCase()).compare(String(a.title || ""), String(b.title || ""))
    || Number(b.revision || 0) - Number(a.revision || 0)
    || String(a.id).localeCompare(String(b.id)));
  const visibleDocumentsByLanguage = visibleDocuments.reduce((groups, doc) => {
    const language = String(doc.language_code || "und").trim().toLowerCase();
    if (!groups.has(language)) groups.set(language, []);
    groups.get(language).push(doc);
    return groups;
  }, new Map());
  const selected = detail?.source || sources.find((source) => source.id === selectedId);

  function openKnowledgeEditor(document = null) {
    setKnowledgeMode("text");
    setEditingDocument(document);
    setEditorMode(document ? "update" : "new");
    setImportTitle(document?.title || "");
    setImportContent(document?.canonical_content || "");
    setImportLanguage(document?.language_code || "en");
    setUploadFile(null);
    setKnowledgeView("edit");
  }

  function startNewKnowledgeEntry() {
    setEditorMode("new");
    setEditingDocument(null);
    setImportTitle("");
    setImportContent("");
    setImportLanguage("en");
    setUploadFile(null);
    setKnowledgeMode("text");
  }

  useEffect(() => {
    if (!openCreateRequest || loading || (data.documents?.length > 0 && !selectedId)) return;
    openKnowledgeEditor();
    onCreateRequestHandled?.();
  }, [openCreateRequest, onCreateRequestHandled, loading, data.documents, selectedId]);

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
      return { message: value.deduplicated ? "No content change; existing revision kept." : `Revision v${value.revision} saved pending review. It is not available to REFAL until approved.` };
    });
  }

  async function importText(event) {
    event.preventDefault();
    await run("import", async () => {
      let targetSourceId = selectedId;
      let saved;
      if (editorMode === "update" && editingDocument?.id) {
        saved = await api(`/api/knowledge/documents/${editingDocument.id}`, { method: "PATCH", body: JSON.stringify({ title: importTitle, content: importContent, language: importLanguage }) });
      } else {
        const created = await api("/api/knowledge", { method: "POST", body: JSON.stringify({ displayName: importTitle }) });
        targetSourceId = created.source.id;
        const value = await api(`/api/knowledge/${targetSourceId}/import`, { method: "POST", body: JSON.stringify({ title: importTitle, content: importContent, language: importLanguage }) });
        saved = value;
        setSelectedId(targetSourceId);
      }
      setImportTitle(""); setImportContent(""); setEditingDocument(null); setEditorMode("new"); setKnowledgeView("content"); setDetail(await api(`/api/knowledge/${targetSourceId}`));
      if (saved.embeddingWarning) return { message: `Saved to the database. Text search is ready, but semantic indexing failed: ${saved.embeddingWarning}` };
      return { message: saved.unchanged ? "No content change detected. The existing revision and review status were kept." : `Revision v${saved.revision} saved as pending review. REFAL will not use or index it until an administrator approves it.` };
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
      formData.append("language", importLanguage);
      // Not the shared api() helper: it always forces Content-Type:
      // application/json, which would break the browser's own multipart
      // boundary for this file upload.
      const response = await fetch(`/api/knowledge/${targetSourceId}/upload`, { method: "POST", credentials: "include", body: formData });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || `Upload failed: ${response.status}`);
      setUploadFile(null); setEditingDocument(null); setEditorMode("new"); setKnowledgeView("content"); setDetail(await api(`/api/knowledge/${targetSourceId}`));
      return { message: value.unchanged ? "No content change detected. The existing revision and review status were kept." : `File saved as revision v${value.revision}, pending review. REFAL will not use or index it until an administrator approves it.` };
    });
  }

  async function archiveSource(source, archived, reason) {
    await run(`archive-${source.id}`, async () => {
      await api(`/api/knowledge/${source.id}/archive`, { method: "PATCH", body: JSON.stringify({ archived, reason }) });
      setArchiveTarget(null); setArchiveReason(""); setArchiveUndo(archived ? { source, archived: true } : null);
      if (selectedId === source.id) setDetail(await api(`/api/knowledge/${source.id}`));
      return { message: archived ? `${source.display_name} archived from agent retrieval.` : `${source.display_name} restored to agent retrieval.` };
    });
  }

  async function reviewDocument(document, status) {
    const reason = String(reviewReasons[document.id] || "").trim();
    if (!reason) { setError("Enter a reason for this review decision."); return; }
    await run(`review-${document.id}`, async () => {
      const result = await api(`/api/knowledge/documents/${document.id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ status, reason })
      });
      setDetail(await api(`/api/knowledge/${document.source_id}`));
      setReviewReasons((current) => ({ ...current, [document.id]: "" }));
      return { message: status === "approved" ? result.embeddingWarning ? `Revision approved, but search indexing needs attention: ${result.embeddingWarning}` : `Revision v${document.revision} approved and indexed in ${result.embeddedChunks} chunks.` : `Revision v${document.revision} marked ${status}.` };
    });
  }

  if (loading) return <Loading />;
  if (loadError) return (
    <div className="page-stack knowledge-page">
      <section className="knowledge-hero">
        <div>
          <span className="knowledge-hero-kicker"><BookOpenCheck size={14} /> KNOWLEDGE OPERATIONS</span>
          <h2>Agent knowledge</h2>
          <p>Knowledge could not be loaded, so the library counts and entries are unavailable.</p>
        </div>
      </section>
      <section className="panel knowledge-load-error" role="alert">
        <p className="error">{loadError}</p>
        <button type="button" className="ghost" onClick={reload}><RefreshCcw size={15} /> Retry loading</button>
      </section>
    </div>
  );
  return (
    <div className="page-stack knowledge-page">
      <section className="knowledge-hero">
        <div>
          <span className="knowledge-hero-kicker"><BookOpenCheck size={14} /> KNOWLEDGE OPERATIONS</span>
          <h2>Agent knowledge</h2>
          <p>Find source material, inspect revisions, and review updates before REFAL uses them in customer answers.</p>
        </div>
        {isAdmin && <button type="button" className="primary knowledge-add-button" onClick={() => openKnowledgeEditor()}><Plus size={16} /> Add knowledge</button>}
      </section>
      <section className="knowledge-summary">
        <article className="knowledge-stat"><span>ACTIVE SOURCES</span><strong>{sources.filter((source) => source.enabled).length}</strong><small>Available to REFAL.</small></article>
        <article className="knowledge-stat approved"><span>APPROVED REVISIONS</span><strong>{documents.filter((doc) => doc.review_status === "approved").length}</strong><small>Ready for retrieval.</small></article>
        <article className="knowledge-stat pending"><span>AWAITING REVIEW</span><strong>{documents.filter((doc) => doc.review_status === "pending").length}</strong><small>Not used by REFAL yet.</small></article>
        <article className="knowledge-stat"><span>ALL REVISIONS</span><strong>{documents.length}</strong><small>Across your knowledge sources.</small></article>
      </section>
      {error && <p className="error knowledge-message">{error}</p>}
      {notice && <p className="notice knowledge-message">{notice}</p>}
      <div className="knowledge-layout">
        <section className="panel knowledge-sources">
          <div className="knowledge-sources-heading"><div><span className="knowledge-section-kicker">LIBRARY</span><h2>Agent knowledge</h2></div><span className="knowledge-result-count">{visibleDocuments.length} {visibleDocuments.length === 1 ? "revision" : "revisions"}</span></div>
          <p className="knowledge-language-note">Language entries are shown separately because their information can differ. Titles are sorted using each language’s alphabet.</p>
          <label className="knowledge-search-label" htmlFor="knowledge-library-search">Search all knowledge</label>
          <input id="knowledge-library-search" className="knowledge-search" type="search" value={knowledgeSearch} onChange={(event) => setKnowledgeSearch(event.target.value)} placeholder="Search titles or content in any language" autoComplete="off" />
          <label className="knowledge-search-label knowledge-category-label" htmlFor="knowledge-category-filter">Filter by category</label>
          <select id="knowledge-category-filter" className="knowledge-category-filter" value={knowledgeDomain} onChange={(event) => setKnowledgeDomain(event.target.value)}><option value="all">All categories</option>{knowledgeDomains.map((domain) => <option key={domain} value={domain}>{domain.replaceAll("-", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())}</option>)}</select>
          <label className="knowledge-search-label knowledge-category-label" htmlFor="knowledge-language-filter">Filter by language</label>
          <select id="knowledge-language-filter" className="knowledge-category-filter" value={knowledgeLanguage} onChange={(event) => setKnowledgeLanguage(event.target.value)}><option value="all">All languages</option>{orderedKnowledgeLanguages.map((language) => <option key={language} value={language}>{languageName(language)}</option>)}</select>
          <label className="knowledge-search-label knowledge-category-label" htmlFor="knowledge-status-filter">Filter by review status</label>
          <select id="knowledge-status-filter" className="knowledge-category-filter" value={knowledgeStatus} onChange={(event) => setKnowledgeStatus(event.target.value)}><option value="all">All review statuses</option>{knowledgeStatuses.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())}</option>)}</select>
          <div className="knowledge-source-list">
            {[...visibleDocumentsByLanguage].sort(([a], [b]) => languageName(a).localeCompare(languageName(b), "en", { sensitivity: "base" }) || a.localeCompare(b)).map(([language, languageDocuments]) => <div className="knowledge-language-group" key={language}>
              <h3 className="knowledge-language-heading">{languageName(language)} <span>{languageDocuments.length} {languageDocuments.length === 1 ? "revision" : "revisions"}</span></h3>
              {languageDocuments.map((doc) => {
              const source = sources.find((item) => item.id === doc.source_id);
              const snippet = String(doc.canonical_content || "").replace(/\s+/g, " ").trim();
              const domainLabel = String(doc.metadata?.domain || "Other").replaceAll("-", " ");
              const topicLabel = String(doc.metadata?.topic || "").replaceAll("-", " ");
              return <button key={doc.id} className={`knowledge-source${selectedId === doc.source_id ? " selected" : ""}`} onClick={() => setSelectedId(doc.source_id)}>
                <span className="knowledge-source-top"><strong dir="auto">{doc.title}</strong><span className={`badge ${doc.review_status === "approved" ? "online" : doc.review_status === "rejected" ? "rejected" : "pending"}`}>{doc.review_status || "unknown"}</span></span>
                <small>{String(doc.language_code || "und").toUpperCase()} · Revision v{doc.revision || 1}{source?.enabled === false ? " · Archived source" : " · Active source"} · {domainLabel}{topicLabel ? ` · ${topicLabel}` : ""} · {source?.display_name || "Knowledge entry"}</small>
                <span className="knowledge-source-preview">{snippet.slice(0, 150)}{snippet.length > 150 ? "…" : ""}</span>
              </button>;
            })}
            </div>)}
            {!documents.length && <p className="knowledge-empty">Nothing active in REFAL’s knowledge database yet.</p>}
            {documents.length > 0 && !visibleDocuments.length && <p className="knowledge-empty">No revisions match these filters{knowledgeSearch.trim() ? ` and “${knowledgeSearch.trim()}”` : ""}. Change the category, language, or review status and try again.</p>}
          </div>
        </section>
        <section className="panel knowledge-detail">
          {!selected ? <p className="empty">Select a knowledge entry to inspect its saved content.</p> : <>
            <PanelTitle icon={Building2} title={detail?.documents?.[0]?.title || selected.display_name} action={isAdmin && !String(selected.canonical_url || "").startsWith("manual:") && <button className="ghost" onClick={fetchSource} disabled={Boolean(busy)}><RefreshCcw size={15} /> {busy === "fetch" ? "Fetching" : "Fetch"}</button>} />
            {selected.last_error && <p className="knowledge-error">{selected.last_error}</p>}
            {knowledgeView === "content" && isAdmin && <div className="knowledge-entry-toolbar"><span>Saved content</span></div>}
            {isAdmin && knowledgeView === "edit" && <section className="knowledge-add-panel" aria-labelledby="knowledge-add-title">
              <div className="knowledge-add-heading"><div><span className="knowledge-add-kicker">KNOWLEDGE DATABASE</span><h3 id="knowledge-add-title">{editorMode === "update" ? `Edit ${editingDocument?.title || "saved knowledge"}` : "Add knowledge for REFAL"}</h3><p>{editorMode === "update" ? "A changed save creates a pending revision. The current approved revision remains available until a reviewer approves the new one." : "New content stays pending and is not available to REFAL until reviewed."}</p></div><button type="button" className="ghost" onClick={() => setKnowledgeView("content")}>Back to content</button></div>
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
                <label htmlFor="knowledge-language">Content language</label>
                <select id="knowledge-language" value={importLanguage} onChange={(event) => setImportLanguage(event.target.value)}><option value="en">English</option><option value="ar">Arabic</option><option value="el">Greek</option></select>
                <label htmlFor="knowledge-content">Knowledge text</label>
                <textarea id="knowledge-content" dir="auto" value={importContent} onChange={(event) => setImportContent(event.target.value)} placeholder="Paste company facts, service details, policies, or FAQs…" rows={7} />
                <KnowledgeCommercialWarning content={importContent} onOpenCommercialData={() => onNavigate("commercial-data")} />
                <div className="knowledge-submit-row"><small>At least 40 characters. Choose the language reviewers should use to assess this revision.</small><button className="primary" disabled={Boolean(busy) || !importTitle.trim() || importContent.trim().length < 40}><Save size={15} /> {busy === "import" ? "Saving for review…" : editorMode === "update" ? "Save pending revision" : "Submit for review"}</button></div>
              </form> : <form className="knowledge-upload" onSubmit={uploadDocument}>
                <label htmlFor="knowledge-file">Choose a text, PDF, or Word file</label>
                <input id="knowledge-file" type="file" accept=".txt,.pdf,.docx" aria-label="Choose a TXT, PDF, or DOCX knowledge file" onChange={(event) => setUploadFile(event.target.files?.[0] || null)} />
                <div className="knowledge-file-note"><BookOpenCheck size={18} /><span><strong>{uploadFile?.name || "Your file will be submitted for review"}</strong><small>REFAL can use its text after an administrator approves the revision.</small></span></div>
                <label htmlFor="knowledge-file-language">Content language</label>
                <select id="knowledge-file-language" value={importLanguage} onChange={(event) => setImportLanguage(event.target.value)}><option value="en">English</option><option value="ar">Arabic</option><option value="el">Greek</option></select>
                <div className="knowledge-submit-row"><small>Supported formats: TXT, PDF, DOCX.</small><button className="primary" disabled={Boolean(busy) || !uploadFile}><Plus size={15} /> {busy === "upload" ? "Saving for review…" : "Submit file for review"}</button></div>
              </form>}
            </section>}
            {knowledgeView === "content" && <div className="knowledge-revisions">
              {(detail?.documents || []).map((doc) => <article className="knowledge-revision" key={doc.id}>
                <div className="knowledge-revision-head"><div><strong>{doc.title}</strong><small>Revision v{doc.revision} · {doc.language_code || "language unspecified"} · Saved {formatDate(doc.fetched_at)} · {doc.chunks.length} chunks{doc.metadata?.sourceFileType ? ` · ${doc.metadata.sourceFileType.toUpperCase()}` : ""}</small><small>Approved by {doc.approved_by || "Not recorded"} · Approved on {formatDate(doc.approved_at)} · Expires {formatDate(doc.valid_until)}</small></div><span className={`badge ${doc.review_status === "approved" ? "online" : doc.review_status === "rejected" ? "rejected" : "pending"}`}>{doc.review_status || "unknown"}</span></div>
                <small className="knowledge-review-source">Source: {selected.display_name}{selected.canonical_url && !selected.canonical_url.startsWith("manual:") ? ` · ${selected.canonical_url}` : " · operator supplied"}{doc.metadata?.sourceFileName ? ` · File: ${doc.metadata.sourceFileName}` : ""}</small>
                {(doc.metadata?.evidence || doc.metadata?.supporting) && <div className="knowledge-review-evidence"><strong>Evidence / supporting references</strong><p>{typeof (doc.metadata.evidence || doc.metadata.supporting) === "string" ? (doc.metadata.evidence || doc.metadata.supporting) : JSON.stringify(doc.metadata.evidence || doc.metadata.supporting)}</p></div>}
                <div className="knowledge-revision-content" dir="auto">{doc.canonical_content}</div>
                {isAdmin && doc.reviewHistory?.length > 0 && <details className="knowledge-review-evidence"><summary>Review decision history ({doc.reviewHistory.length})</summary><ol>{doc.reviewHistory.map((entry) => <li key={entry.id}><strong>{entry.previous_status} → {entry.new_status}</strong><span> · {entry.reviewer} · {formatDate(entry.created_at)}</span><p>{entry.reason}</p></li>)}</ol></details>}
                {isAdmin && <section className="knowledge-review-panel" aria-label={`Review revision ${doc.revision}`}>
                  <div className="knowledge-review-heading"><div><strong>Review this revision</strong><small>Add a reason to enable a decision.</small></div></div>
                  <label htmlFor={`knowledge-review-reason-${doc.id}`}>Decision reason<textarea id={`knowledge-review-reason-${doc.id}`} aria-label={`Reason for review decision on ${doc.title}`} placeholder="Explain why this revision is approved, returned, or rejected." value={reviewReasons[doc.id] || ""} onChange={(event) => setReviewReasons((current) => ({ ...current, [doc.id]: event.target.value }))} maxLength={500} rows={3} /></label>
                  <div className="knowledge-review-actions">
                    <button className="primary" onClick={() => reviewDocument(doc, "approved")} disabled={Boolean(busy) || doc.review_status === "approved" || !reviewReasons[doc.id]?.trim()}>{busy === `review-${doc.id}` ? "Saving review…" : "Approve and index"}</button>
                    <button className="ghost" onClick={() => reviewDocument(doc, "pending")} disabled={Boolean(busy) || doc.review_status === "pending" || !reviewReasons[doc.id]?.trim()}>Return to pending</button>
                    <button className="knowledge-delete-button" onClick={() => reviewDocument(doc, "rejected")} disabled={Boolean(busy) || doc.review_status === "rejected" || !reviewReasons[doc.id]?.trim()}>Reject</button>
                  </div>
                </section>}
                {isAdmin && <div className="knowledge-entry-actions"><button className="ghost" onClick={() => openKnowledgeEditor(doc)}><Save size={14} /> Edit</button></div>}
              </article>)}
              {!detail?.documents?.length && <p className="empty">No knowledge saved yet. Select Add knowledge to paste text or upload a file.</p>}
            </div>}
          </>}
        </section>
      </div>
      {isAdmin && selected && <div className="knowledge-archive-actions">
        {selected.enabled ? <button type="button" className="ghost" onClick={() => { setArchiveTarget(selected); setArchiveReason(""); }}>Archive source</button> : <button type="button" className="ghost" onClick={() => archiveSource(selected, false, "Restored by administrator from the knowledge archive.")} disabled={Boolean(busy)}>Restore source</button>}
      </div>}
      {archiveUndo?.archived && <p className="notice knowledge-message" role="status">Source archived. <button type="button" className="ghost" onClick={() => archiveSource(archiveUndo.source, false, "Undo archive action.")} disabled={Boolean(busy)}>Undo</button></p>}
      {archiveTarget && <div className="knowledge-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setArchiveTarget(null); }}>
        <section className="knowledge-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-archive-title" aria-describedby="knowledge-archive-description">
          <h2 id="knowledge-archive-title">Archive this source?</h2><p className="knowledge-delete-dialog-entry">{archiveTarget.display_name}</p>
          <p id="knowledge-archive-description">REFAL will stop retrieving every revision from this source. The content and review history remain saved. You can restore it later.</p>
          <label htmlFor="knowledge-archive-reason">Reason for archive</label><textarea id="knowledge-archive-reason" value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} maxLength={500} rows={3} />
          <div className="knowledge-delete-dialog-actions"><button type="button" onClick={() => setArchiveTarget(null)} disabled={Boolean(busy)}>Cancel</button><button type="button" className="knowledge-delete-confirm-button" onClick={() => archiveSource(archiveTarget, true, archiveReason)} disabled={Boolean(busy) || !archiveReason.trim()}>{busy === `archive-${archiveTarget.id}` ? "Archiving…" : "Archive source"}</button></div>
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
  const [credits, setCredits] = useState(null);
  const [creditsRefresh, setCreditsRefresh] = useState(0);
  const loading = overviewLoading;
  const status = overviewData.status || {};
  const usage = overviewData.usage || {};
  const actualUsage = overviewData.usageAnalytics?.actual || {};
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthUsage = actualUsage.byMonth?.find((month) => month.period === currentMonth) || {};
  const hasReportedCost = Number(monthUsage.exactCostInteractions || 0) > 0;
  const missingCostInteractions = Number(monthUsage.missingCostInteractions || 0);
  const whatsappReady = status.connected === true;

  useEffect(() => {
    if (!isAdmin) return undefined;
    let active = true;
    const loadCredits = async () => {
      try {
        const response = await fetch("/api/openrouter/credits", { credentials: "include", cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("Could not verify provider credits.");
        if (active) setCredits(body);
      } catch {
        if (active) setCredits({ available: false, reason: "temporarily_unavailable" });
      }
    };
    void loadCredits();
    const timer = setInterval(loadCredits, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [isAdmin, creditsRefresh]);

  function refreshAll() {
    reloadOverview();
    setControlRefresh((value) => value + 1);
    setCreditsRefresh((value) => value + 1);
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
          <div className="agent-usage-model"><span>Configured model</span><strong>{usage.model || "Not set"}</strong></div>
          <dl className="agent-usage-metrics">
            <div><dt>Requests</dt><dd>{numberValue(monthUsage.interactions).toLocaleString("en-US")}<small>This month</small></dd></div>
            <div><dt>Tokens</dt><dd>{numberValue(monthUsage.actualTokens).toLocaleString("en-US")}<small>Provider reported</small></dd></div>
            <div><dt>Provider cost</dt><dd>{hasReportedCost ? formatUsageUsd(monthUsage.exactCostUsd) : "Unavailable"}<small>This month · provider reported</small></dd></div>
            {isAdmin && <div><dt>Remaining credits</dt><dd>{credits === null ? "Checking…" : credits.available ? formatUsageUsd(credits.remainingCreditsUsd) : "Unavailable"}<small>{credits === null ? "Checking connected account" : openRouterCreditHint(credits)}</small></dd></div>}
          </dl>
          <p className="hint">Usage reflects recorded provider data. {missingCostInteractions ? `Cost was not reported for ${missingCostInteractions.toLocaleString("en-US")} of ${numberValue(monthUsage.interactions).toLocaleString("en-US")} requests.` : "The provider reports exact cost for the requests included above."}</p>
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
  const { data, setData, loading, reload } = useApi(`/api/leads/${encodeURIComponent(userId)}`, [userId]);
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
  }, [data.user?.nameOverride, data.user?.phoneOverride, data.profile?.needOverride, data.profile?.conversationSummary]);

  async function saveContact() {
    setSaving(true);
    setMessage("");
    try {
      const saved = await api(`/api/leads/${encodeURIComponent(userId)}/contact`, {
        method: "PUT",
        body: JSON.stringify({
          contact,
          expected: {
            nameOverride: data.user?.nameOverride || "",
            phoneOverride: data.user?.phoneOverride || "",
            needOverride: data.profile?.needOverride || "",
            conversationSummary: data.profile?.conversationSummary || ""
          }
        })
      });
      setData({ ...data, profile: saved.profile });
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
            {message && <span role="status">{message}</span>}
            {message.includes("Reload the current values") && <button type="button" className="ghost" onClick={reload}>Reload current contact values</button>}
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
  const [calendarOAuthBusy, setCalendarOAuthBusy] = useState(false);
  const [calendarOAuthSetup, setCalendarOAuthSetup] = useState(null);
  const [calendarOAuthSubmitted, setCalendarOAuthSubmitted] = useState(false);
  const [calendarOAuthMessage, setCalendarOAuthMessage] = useState("");
  const calendarOAuthFormRef = useRef(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reviewing, setReviewing] = useState("");

  useEffect(() => () => calendarOAuthFormRef.current?.reset(), []);

  useEffect(() => {
    if (!readiness) return;
    setPolicy(readiness.policy || {
      timezone: "Europe/Nicosia", calendarId: "primary", weekdays: [1, 2, 3, 4, 5],
      startTime: "10:00", endTime: "15:00", durationMinutes: 60, durationOwnerConfirmed: true,
      minimumNoticeHours: 24, reminderHours: [24, 1], createMeetLink: false
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

  const startCalendarAuthorization = async () => {
    setCalendarOAuthBusy(true); setCalendarOAuthMessage(""); setCalendarOAuthSetup(null); setCalendarOAuthSubmitted(false);
    try {
      const result = await api("/api/bookings/calendar-oauth/start", { method: "POST", body: JSON.stringify({}) });
      setCalendarOAuthSetup(result);
      setCalendarOAuthMessage("Setup helper ready. Paste the OAuth JSON below; the browser sends it directly to the local helper, not the dashboard server.");
    } catch (cause) { setCalendarOAuthMessage(cause.message || "Could not start Google Calendar authorization."); }
    finally { setCalendarOAuthBusy(false); }
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
      {readiness && <section className={`booking-readiness${readiness.active ? " is-ready" : " is-blocked"}`} role="status" aria-live="polite">
        <div className="booking-readiness-icon"><ShieldCheck size={19} /></div>
        <div className="booking-readiness-copy">
          <strong>{readiness.active ? "Calendar booking is ready" : "Calendar booking is not enabled"}</strong>
          <span>{readiness.active ? "Calendar access and booking rules are ready." : "Appointments are paused until the items below are ready."}</span>
          <div className="booking-readiness-tags">
            <span className={readiness.calendarCredentials ? "ready" : "missing"}>{readiness.calendarCredentials ? "Worker credentials configured" : "REFAL worker authorization missing"}</span>
            <span className={readiness.calendarAccessVerified ? "ready" : "missing"}>{readiness.calendarAccessVerified ? `Calendar access verified ${formatDate(readiness.calendarAccessCheckedAt)}` : "Calendar access not verified"}</span>
            <span className={readiness.policy?.durationOwnerConfirmed && readiness.policy.durationMinutes ? "ready" : "missing"}>{readiness.policy?.durationOwnerConfirmed ? `Duration ${readiness.policy.durationMinutes} min` : "Confirmed duration required"}</span>
            <span className={readiness.policy?.minimumNoticeHours != null ? "ready" : "missing"}>{readiness.policy?.minimumNoticeHours != null ? "Booking notice set" : "Minimum notice not set"}</span>
            <span className={readiness.policy?.reminderHours?.length ? "ready" : "missing"}>{readiness.policy?.reminderHours?.length ? "Reminder schedule set" : "Reminder schedule not set"}</span>
          </div>
          {readiness.active && readiness.policy && !readiness.policy.createMeetLink && <small>Google Meet link creation is disabled; confirmed appointments will not include a Meet link.</small>}
          {!readiness.active && <small>Your personal Google Calendar connection does not authorize the WhatsApp worker. Configure worker credentials, then test access here before relying on calendar bookings.</small>}
        </div>
      </section>}
      {isAdmin && policy && <section className="panel booking-policy" id="booking-policy">
        <PanelTitle icon={Settings} title="Booking policy" />
        <p className="booking-policy-intro">Rules are stored in Supabase. OAuth credentials go directly from your browser to a loopback helper, then are stored for the WhatsApp worker only.</p>
        {!readiness?.calendarCredentials && <div className="calendar-oauth-setup">
          {!calendarOAuthSetup || readiness?.calendarAuthorizationStatus === "error" ? <button className="ghost" type="button" disabled={calendarOAuthBusy} onClick={startCalendarAuthorization}>{calendarOAuthBusy ? "Starting secure authorization…" : "Set up Google Calendar"}</button> : calendarOAuthSubmitted ? <p>OAuth JSON was sent directly to the local helper. Complete Google's consent in the new tab, then refresh status.</p> : <form ref={calendarOAuthFormRef} action={calendarOAuthSetup.submissionUrl} method="post" target="refal-calendar-authorization" encType="application/x-www-form-urlencoded" onSubmit={() => { setCalendarOAuthSubmitted(true); setCalendarOAuthMessage("OAuth JSON was submitted directly to the local helper. Complete consent in the new tab."); window.setTimeout(() => calendarOAuthFormRef.current?.reset(), 100); }}>
            <input type="hidden" name="token" value={calendarOAuthSetup.setupToken} />
            <label className="field">Google OAuth client JSON<textarea name="clientJson" rows="5" required maxLength={1024 * 1024} disabled={calendarOAuthSubmitted} autoComplete="off" spellCheck="false" placeholder="Paste the downloaded OAuth client JSON. It must include the REFAL loopback redirect URI." /></label>
            <button className="ghost" type="submit" disabled={calendarOAuthSubmitted}>Continue to authorization</button>
          </form>}
          {calendarOAuthMessage && <span role="status">{calendarOAuthMessage}</span>}
          {calendarOAuthSetup && <button className="ghost" type="button" onClick={reloadReadiness}>Refresh authorization status</button>}
          <small>Google consent is required. REFAL requests calendar event and availability access only. This local onboarding flow requires the dashboard browser and helper to run on the same machine.</small>
        </div>}
        {readiness?.calendarAuthorizationStatus === "configured_worker_restart_needed" && <p className="booking-policy-intro">Authorization is saved. Reconnect the WhatsApp worker so it loads the new worker credentials.</p>}
        {readiness?.calendarAuthorizationStatus === "configured_worker_restarting" && <p className="booking-policy-intro">Authorization is saved. The connected WhatsApp worker is restarting with the new credentials.</p>}
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
              {pending && <div className="booking-pending-note"><Clock3 size={16} /><span><strong>{booking.status === "pending_review" ? "Waiting for Refalco Group review" : "Waiting for Google Calendar"}</strong><small>{booking.status === "pending_review" ? "The customer requested this time. Availability is not verified, and the appointment is not confirmed." : "The booking is saved, but Google has not confirmed it yet."}</small></span></div>}
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

  return { data, setData, loading, error, reload: () => { apiGetCache.delete(url); setTick((value) => value + 1); } };
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
    if (!response.ok) {
      const error = new Error(body.error || `Request failed: ${response.status}`);
      error.status = response.status;
      error.code = body.code;
      throw error;
    }
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

function openRouterCreditHint(credits) {
  if (credits?.available) return `Verified from OpenRouter · ${formatDate(credits.checkedAt)}`;
  if (credits?.reason === "management_key_required") return "A management key is required to verify the account balance.";
  if (credits?.reason === "not_configured") return "No OpenRouter key is configured.";
  return "The account balance could not be verified.";
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
