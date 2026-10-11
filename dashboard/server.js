import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { canAccessDashboardSession, clearAuthCookies, createRequestAuthClient, isSameOriginRequest, roleAllows, validPassword } from "./auth.js";
import { assertPasteWithinLimit, chunkKnowledge, extractKnowledgeText, extractUploadedDocument, fetchKnowledgePage, MAX_UPLOAD_BYTES, normalizeKnowledgeContent, UPLOAD_MIME_TYPES, validateKnowledgeUrl } from "./knowledge.js";
import { contactActivityStats, operatorSignals, recentConversations } from "./activity.js";
import { createWhatsAppController } from "./whatsappController.js";
import { aggregateModelUsage, normalizeQualificationStatus } from "./performance.js";
import { buildModelUsageEvent } from "./modelUsageTelemetry.js";
import { createAgentRateLimit } from "./agentRateLimit.js";
import { deleteConversationTranscript } from "./conversationDelete.js";
import { displayName, isPlausibleCustomerName } from "./contactIdentity.js";
import { countUniqueHandoverContacts } from "./handoverGrouping.js";
import { dueFacts, editFactReview, factAudit, listFacts, reapproveFact, setFactStatus } from "./factRegisterView.js";
import { hasPurposeBoundFollowUpConsent } from "../supabase/functions/rafa-agent-api/handoverPersistence.mjs";
import { registerDynamicDataAdminRoutes } from "./dynamicDataAdmin.js";
import { registerContactCorrectionAdminRoutes } from "./contactCorrectionAdmin.js";
import { approveKnowledgeDocumentAfterIndex, previewKnowledgeAcrossLanguages, reviewKnowledgeDocument, setKnowledgeSourceArchived } from "./knowledgeReview.js";
import { normalizeHandoverLanguage } from "./handoverFilters.js";
import { readAllRows, withStableCreatedAtIdOrder, withStableIdOrder } from "./readAllRows.js";
import { mapWithConcurrency } from "./mapWithConcurrency.js";
import { HandoverStatusSyncError, syncHandoverStatus } from "./handoverStatusSync.js";
import { createCalendarCredentialOnboarding } from "./calendarCredentialOnboarding.js";
import { loadDashboardEnv, stripWorkerCalendarCredentials } from "./dashboardEnv.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// REFAL-ADMIN-KB — admin-uploaded PDF/DOCX/TXT knowledge. Memory storage is
// safe here: MAX_UPLOAD_BYTES bounds the buffer size, and multer rejects
// anything larger before this process ever holds it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });
const require = createRequire(import.meta.url);
const { generateConversationReport } = require("../src/report.js");
const { createStore } = require("../src/supabaseStore.js");
const { embedText, embedTexts, normalizeOpenRouterUsage, DEFAULT_EMBEDDING_MODEL, warmEmbeddingPipeline } = require("../src/ai.js");
const { containsUnconsentedContactCommitment } = require("../src/responsePolicy.js");
const { formatBookingTime, suggestAvailableTimes } = require("../src/booking.js");
const { createCalendarReadinessTracker, isBookingPolicyReady } = require("../src/calendarReadiness.js");
const { validateBookingPolicy } = require("../src/bookingPolicy.js");
const { workerCredentialsReady } = require("../scripts/googleCalendarCredentialStore.js");
const { dashboardFailureReply } = await import("./agentFallback.js");
const {
  DEFAULT_OPENROUTER_MODEL,
  resolveOpenRouterModel
} = require("../src/openrouterPrivacy.js");
const dashboardRoot = __dirname;
const botRoot = path.resolve(dashboardRoot, "..");
stripWorkerCalendarCredentials(process.env);

loadDashboardEnv(path.join(botRoot, ".env"));
loadDashboardEnv(path.join(botRoot, ".env.rafa"));
const store = createStore();
const whatsappController = createWhatsAppController({ botRoot });

// REFAL-ADMIN-KB — this process (the dashboard API) embeds knowledge saves
// and searches with the same local transformers pipeline as src/bot.js, but
// runs as a separate Node process with its own lazy-loaded singleton. Without
// this warmup, the first knowledge save/search after every dashboard restart
// pays the full model-load cost inline inside that HTTP request.
const embeddingWarmStartedAt = performance.now();
void warmEmbeddingPipeline().then(() => {
  void logDashboardEvent("response_stage", { stage: "embedding_model_warmup", durationMs: Math.round(performance.now() - embeddingWarmStartedAt) });
}).catch((error) => {
  void logDashboardEvent("embedding_warmup_error", { message: String(error?.message || error).slice(0, 200) });
});

const app = express();
const port = Number(process.env.DASHBOARD_PORT || 8787);
const authAttemptBuckets = new Map();
const limitAgentChat = createAgentRateLimit();
const calendarReadiness = createCalendarReadinessTracker();
const calendarOnboarding = createCalendarCredentialOnboarding({ botRoot, onConfigured: () => whatsappController.restart() });
let openRouterCreditsCache = { expiresAt: 0, value: null };

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (isSameOriginRequest(req.get("origin"), req.get("host"), req.get("sec-fetch-site"), req.protocol)) return next();
  return res.status(403).json({ error: "Cross-origin request rejected." });
});

app.post("/api/login", authRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!email || !password || email.length > 320 || password.length > 1024) {
    return res.status(400).json({ error: "Enter a valid email address and password." });
  }
  try {
    const client = createRequestAuthClient(req, res);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.user) return res.status(401).json({ error: "Email or password is incorrect." });
    const account = await dashboardAccount(data.user.id);
    if (account && !account.is_active) {
      await client.auth.signOut({ scope: "local" });
      clearAuthCookies(req, res, Boolean(req.secure));
      return res.status(403).json({ error: "This account is disabled." });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, authenticated: true, role: account?.role || "pending", user: publicUser(data.user, account) });
  } catch (error) {
    res.status(error.statusCode || 503).json({ error: error.statusCode === 503 ? error.message : "Sign-in is temporarily unavailable." });
  }
});

app.post("/api/auth/forgot-password", authRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email || email.length > 320) return res.status(400).json({ error: "Enter a valid email address." });
  try {
    const client = createRequestAuthClient(req, res);
    const siteUrl = process.env.DASHBOARD_AUTH_SITE_URL || `${req.protocol}://${req.get("host")}`;
    await client.auth.resetPasswordForEmail(email, { redirectTo: new URL("/auth/callback?next=reset", siteUrl).href });
  } catch { /* Keep account-existence and provider errors indistinguishable. */ }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, message: "If this account is registered, a password reset link will arrive shortly." });
});

app.post("/api/auth/exchange-code", authRateLimit, async (req, res) => {
  const code = String(req.body?.code || "");
  if (!code || code.length > 4096) return res.status(400).json({ error: "This password link is invalid or has expired." });
  try {
    const client = createRequestAuthClient(req, res);
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error || !data.user) return res.status(400).json({ error: "This password link is invalid or has expired." });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: "This password link is invalid or has expired." });
  }
});

app.post("/api/auth/update-password", requireSignedIn, authRateLimit, async (req, res) => {
  const password = req.body?.password;
  if (!validPassword(password)) return res.status(400).json({ error: "Use at least 12 characters with uppercase, lowercase, and a number." });
  const { error } = await req.authClient.auth.updateUser({ password });
  if (error) return res.status(400).json({ error: "The new password could not be saved. Request a fresh reset link and try again." });
  await req.authClient.auth.signOut({ scope: "global" });
  clearAuthCookies(req, res, Boolean(req.secure));
  res.json({ ok: true, signedOut: true });
});

app.post("/api/auth/bootstrap-admin", requireSignedIn, authRateLimit, async (req, res) => {
  try {
    const result = await invokeAdminFunction(req.authClient, { action: "bootstrap-admin" });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post("/api/logout", async (req, res) => {
  try {
    const client = createRequestAuthClient(req, res);
    await client.auth.signOut({ scope: "local" });
  } catch { /* Always clear local cookies, even if Supabase is unavailable. */ }
  clearAuthCookies(req, res, Boolean(req.secure));
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

app.get("/api/session", async (req, res) => {
  try {
    const identity = await resolveDashboardIdentity(req, res);
    res.setHeader("Cache-Control", "no-store");
    if (!identity?.user) return res.json({ authenticated: false });
    if (identity.account && !identity.account.is_active) return res.json({ authenticated: false, disabled: true, error: "This account has been disabled. Contact a workspace administrator." });
    res.json({ authenticated: true, role: identity.account?.role || "pending", user: publicUser(identity.user, identity.account) });
  } catch (error) {
    res.status(error.statusCode || 503).json({ authenticated: false, error: error.statusCode ? error.message : "Could not verify the dashboard session." });
  }
});

app.use("/api", requireAuth);
registerDynamicDataAdminRoutes(app, { requireAdmin });
registerContactCorrectionAdminRoutes(app, { store, requireAdmin });

app.get("/api/whatsapp/control", requireAdmin, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const control = whatsappController.snapshot();
  if (control.state !== "disconnected") return res.json(control);

  try {
    const status = botStatus(await readEvents());
    if (status.connected) {
      return res.json({
        ...control,
        state: "connected",
        connectedAt: status.lastConnectionEvent || status.lastSeen,
        managed: false,
        external: true
      });
    }
  } catch {
    // Keep the controller snapshot if event status cannot be read.
  }
  res.json(control);
});

app.post("/api/whatsapp/connect", requireAdmin, authRateLimit, (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json(whatsappController.connect(req.body?.phoneNumber, req.body?.pairingMethod || "code"));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Could not start the WhatsApp connection." });
  }
});

app.post("/api/whatsapp/disconnect", requireAdmin, authRateLimit, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(whatsappController.disconnect());
});

app.post("/api/whatsapp/stop-local-worker", requireAdmin, authRateLimit, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const control = whatsappController.snapshot();
  if (control.state !== "disconnected") return res.json(whatsappController.disconnect());

  try {
    const stoppedPids = await stopLocalWhatsAppWorkers();
    if (stoppedPids.length) {
      await logDashboardEvent("connection_close", {
        source: "dashboard_stop_local_worker",
        stoppedPids
      });
    }
    res.json({
      ...control,
      state: "disconnected",
      connectedAt: null,
      external: false,
      stoppedExternal: stoppedPids.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not stop the local RAFA worker." });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try { res.json(await invokeAdminFunction(req.authClient, { action: "list-users" })); }
  catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
});

// Assumption: workflow actions are persisted as rafa_events fields by the existing store seam.
// This read-only admin view intentionally returns actor/action/target metadata only; it never
// returns prompts, credentials, customer message bodies, or internal model reasoning.
app.get("/api/admin/audit", requireAdmin, async (_req, res) => {
  try {
    const events = await readEvents();
    const auditEvents = new Set(["dashboard_admin_action", "contact_memory_admin_updated", "lead_qualification_admin_updated", "conversation_reply_admin_edited"]);
    res.json({ events: events.filter((event) => auditEvents.has(event.event)).slice(-100).reverse().map((event) => ({
      event: event.event,
      at: event.at,
      actor: String(event.actor || event.reviewer || "admin").slice(0, 160),
      action: String(event.action || event.event).slice(0, 120),
      targetId: String(event.contactId || event.userId || event.targetId || "").slice(0, 200),
      fields: Array.isArray(event.fields) ? event.fields.slice(0, 20).map((field) => String(field).slice(0, 80)) : []
    })) });
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not load the admin audit." });
  }
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email || email.length > 320) return res.status(400).json({ error: "Enter a valid email address." });
  try { res.status(201).json(await invokeAdminFunction(req.authClient, { action: "invite-user", email })); }
  catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
});

app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const userId = requireUuid(req.params.id);
  const role = req.body?.role;
  const isActive = req.body?.isActive;
  if (role !== undefined && !["admin", "user"].includes(role)) return res.status(400).json({ error: "Role must be admin or user." });
  if (isActive !== undefined && typeof isActive !== "boolean") return res.status(400).json({ error: "isActive must be a boolean." });
  if (role === undefined && isActive === undefined) return res.status(400).json({ error: "No supported account changes supplied." });
  try { res.json(await invokeAdminFunction(req.authClient, { action: "update-user", userId, role, isActive })); }
  catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
});

app.get("/api/knowledge", async (req, res) => {
  try {
    const isAdmin = req.dashboardUser.role === "admin";
    const documentQuery = `rafa_knowledge_documents?select=id,source_id,revision,title,canonical_content,content_sha256,language_code,review_status,fetched_at,approved_at,approved_by,valid_until,metadata${isAdmin ? "" : "&review_status=eq.approved"}&order=fetched_at.desc,id.desc`;
    const [sources, documents] = await Promise.all([
      supabaseRest(`rafa_knowledge_sources?select=id,canonical_url,display_name,source_kind,trust_tier,enabled,approved,approval_note,last_status,last_error,last_fetched_at,last_success_at,last_content_hash,created_at,updated_at${isAdmin ? "" : "&enabled=eq.true&approved=eq.true"}&order=updated_at.desc`),
      isAdmin ? readAllSupabaseRows(withStableIdOrder(documentQuery, "fetched_at")) : supabaseRest(`${documentQuery}&limit=200`)
    ]);
    res.json({ sources, documents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/knowledge", requireAdmin, async (req, res) => {
  try {
    const displayName = String(req.body?.displayName || "").trim().slice(0, 160);
    if (!displayName) return res.status(400).json({ error: "A source name is required." });
    // REFAL-ADMIN-KB — a source backed by an uploaded file or pasted text has
    // no real fetchable URL. canonical_url stays NOT NULL/unique, so a
    // synthetic, never-fetched placeholder stands in for it; nothing ever
    // calls fetchKnowledgePage/validateKnowledgeUrl against a "manual:" value.
    const canonicalUrl = String(req.body?.url || "").trim() ? validateKnowledgeUrl(req.body.url).href : `manual:${crypto.randomUUID()}`;
    const rows = await supabaseRest("rafa_knowledge_sources?select=id,canonical_url,display_name,source_kind,trust_tier,enabled,approved,last_status", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ canonical_url: canonicalUrl, display_name: displayName, source_kind: "manual", trust_tier: "operator_supplied", enabled: true, approved: true, approval_note: "Operator-supplied source; each content revision requires review before REFAL can use it." })
    });
    res.status(201).json({ source: rows[0] });
  } catch (error) {
    res.status(error.code || 400).json({ error: error.message });
  }
});

app.patch("/api/knowledge/:id", requireAdmin, async (req, res) => {
  try {
    const id = requireUuid(req.params.id);
    const patch = {};
    for (const key of ["enabled", "approved"]) {
      if (req.body?.[key] !== undefined) {
        if (typeof req.body[key] !== "boolean") return res.status(400).json({ error: `${key} must be boolean.` });
        if (key === "enabled") return res.status(400).json({ error: "Use the audited archive or restore action to change source availability." });
        if (req.body[key] === false) return res.status(400).json({ error: "Knowledge sources remain approved; review each content revision instead." });
        patch[key] = true;
      }
    }
    if (req.body?.approvalNote !== undefined) patch.approval_note = String(req.body.approvalNote).slice(0, 1000);
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No supported source changes supplied." });
    patch.updated_at = new Date().toISOString();
    if (patch.enabled === false) patch.last_status = "disabled";
    else if (patch.enabled === true) patch.last_status = "ready";
    const rows = await supabaseRest(`rafa_knowledge_sources?id=eq.${id}&select=id,canonical_url,display_name,enabled,approved,approval_note,last_status`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch)
    });
    if (!rows[0]) return res.status(404).json({ error: "Knowledge source not found." });
    res.json({ source: rows[0] });
  } catch (error) {
    res.status(error.code || 500).json({ error: error.message });
  }
});

app.post("/api/knowledge/:id/fetch", requireAdmin, async (req, res) => {
  let id;
  try {
    id = requireUuid(req.params.id);
    const sources = await supabaseRest(`rafa_knowledge_sources?id=eq.${id}&select=id,canonical_url,display_name&limit=1`);
    const source = sources[0];
    if (!source) return res.status(404).json({ error: "Knowledge source not found." });
    await supabaseRest(`rafa_knowledge_sources?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ last_status: "fetching", last_error: "", last_fetched_at: new Date().toISOString() }) });
    const page = await fetchKnowledgePage(source.canonical_url);
    const extracted = extractKnowledgeText(page.html, page.url);
    const saved = await storeKnowledgeRevision(id, extracted, "en");
    res.json({ ...saved, embeddedChunks: 0, embeddingWarning: "", title: extracted.title, characterCount: extracted.content.length, chunkCount: extracted.chunks.length });
  } catch (error) {
    const status = error.code || 502;
    try {
      await supabaseRest(`rafa_knowledge_sources?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ last_status: [401, 403, 415, 429].includes(status) ? "blocked" : "failed", last_error: String(error.message || "Fetch failed").slice(0, 500) }) });
    } catch { /* Preserve the ingestion error if status reporting is unavailable. */ }
    res.status(status).json({ error: error.message });
  }
});

app.post("/api/knowledge/:id/import", requireAdmin, async (req, res) => {
  try {
    const id = requireUuid(req.params.id);
    const title = String(req.body?.title || "Operator-provided content").trim().slice(0, 500);
    const content = normalizeKnowledgeContent(req.body?.content);
    assertPasteWithinLimit(content);
    if (content.length < 40) return res.status(400).json({ error: "Import at least 40 characters of source content." });
    const extracted = { title, content, chunks: chunkKnowledge(content) };
    const saved = await storeKnowledgeRevision(id, extracted, String(req.body?.language || "en").slice(0, 8));
    res.status(201).json({ ...saved, embeddedChunks: 0, embeddingWarning: "", characterCount: content.length, chunkCount: extracted.chunks.length });
  } catch (error) {
    res.status(error.code || 500).json({ error: error.message });
  }
});

app.patch("/api/knowledge/documents/:id", requireAdmin, async (req, res) => {
  try {
    const id = requireUuid(req.params.id);
    const title = String(req.body?.title || "").trim().slice(0, 500);
    const content = normalizeKnowledgeContent(req.body?.content);
    assertPasteWithinLimit(content);
    if (!title) return res.status(400).json({ error: "Enter a title for this knowledge entry." });
    if (content.length < 40) return res.status(400).json({ error: "Enter at least 40 characters of knowledge text." });

    const documents = await supabaseRest(`rafa_knowledge_documents?id=eq.${id}&select=id,source_id&limit=1`);
    if (!documents[0]) return res.status(404).json({ error: "Knowledge entry not found." });
    const chunks = chunkKnowledge(content);
    const result = await storeKnowledgeRevision(documents[0].source_id, { title, content, chunks }, String(req.body?.language || "en").slice(0, 8));
    res.json({ ...result, embeddedChunks: 0, embeddingWarning: "", chunkCount: chunks.length });
  } catch (error) {
    res.status(error.code || 500).json({ error: error.message || "Could not update this knowledge entry." });
  }
});

app.post("/api/knowledge/:id/upload", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const id = requireUuid(req.params.id);
    if (!req.file) return res.status(400).json({ error: "Attach a file to upload." });
    const extracted = await extractUploadedDocument({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
      title: req.body?.title,
      language: req.body?.language
    });
    const saved = await storeKnowledgeRevision(id, extracted, extracted.language, {
      sourceFileType: extracted.sourceFileType,
      sourceFileName: extracted.sourceFileName
    });
    res.status(201).json({ ...saved, embeddedChunks: 0, embeddingWarning: "", title: extracted.title, characterCount: extracted.content.length, chunkCount: extracted.chunks.length });
  } catch (error) {
    res.status(error.code || 500).json({ error: error.message });
  }
});

app.get("/api/knowledge/:id", async (req, res) => {
  try {
    const id = requireUuid(req.params.id);
    const isAdmin = req.dashboardUser.role === "admin";
    const documentQuery = `rafa_knowledge_documents?source_id=eq.${id}${isAdmin ? "" : "&review_status=eq.approved"}&select=id,source_id,revision,title,canonical_content,content_sha256,language_code,review_status,fetched_at,approved_at,approved_by,valid_until,metadata&order=revision.desc,id.desc`;
    const [sources, documents] = await Promise.all([
      supabaseRest(`rafa_knowledge_sources?id=eq.${id}&select=*${isAdmin ? "" : "&enabled=eq.true&approved=eq.true"}&limit=1`),
      isAdmin ? readAllSupabaseRows(withStableIdOrder(documentQuery, "revision")) : supabaseRest(`${documentQuery}&limit=1`)
    ]);
    if (!sources[0]) return res.status(404).json({ error: "Knowledge source not found." });
    const documentIdBatches = [];
    for (let index = 0; index < documents.length; index += 50) documentIdBatches.push(documents.slice(index, index + 50).map((doc) => doc.id));
    const chunks = (await mapWithConcurrency(documentIdBatches, (batch) => readAllSupabaseRows(
      `rafa_knowledge_chunks?document_id=in.(${batch.join(",")})&select=id,document_id,chunk_index,heading,content,metadata,embedding_model,embedded_at&order=chunk_index.asc,id.asc`
    ))).flat();
    const reviewAuditBatches = [];
    for (let index = 0; index < documents.length; index += 50) reviewAuditBatches.push(documents.slice(index, index + 50).map((doc) => doc.id));
    const reviewAudit = isAdmin ? (await mapWithConcurrency(reviewAuditBatches, (batch) => readAllSupabaseRows(
      `rafa_knowledge_review_audit?document_id=in.(${batch.join(",")})&select=id,document_id,previous_status,new_status,reviewer,reason,created_at&order=created_at.asc,id.asc`
    ))).flat() : [];
    const reviewAuditByDocument = new Map();
    for (const entry of reviewAudit) {
      const history = reviewAuditByDocument.get(entry.document_id) || [];
      history.push(entry);
      reviewAuditByDocument.set(entry.document_id, history);
    }
    res.json({ source: sources[0], documents: documents.map((doc) => ({
      ...doc,
      chunks: chunks.filter((chunk) => chunk.document_id === doc.id),
      ...(isAdmin ? { reviewHistory: reviewAuditByDocument.get(doc.id) || [] } : {})
    })) });
  } catch (error) {
    res.status(error.code || 500).json({ error: error.message });
  }
});

app.patch("/api/knowledge/documents/:id/review", requireAdmin, async (req, res) => {
  try {
    const id = requireUuid(req.params.id);
    const status = req.body?.status;
    if (!["approved", "rejected", "pending"].includes(status)) return res.status(400).json({ error: "Review status must be approved, rejected, or pending." });
    const reviewer = String(req.dashboardUser?.email || req.dashboardUser?.id || "").trim();
    let decision;
    let embeddedChunks = 0;
    if (status === "approved") {
      const indexed = await approveKnowledgeDocumentAfterIndex(supabaseRest, {
        documentId: id,
        reviewer,
        reason: req.body?.reason,
        embeddingModel: DEFAULT_EMBEDDING_MODEL,
        loadChunks: (documentId) => supabaseRest(`rafa_knowledge_chunks?document_id=eq.${documentId}&select=chunk_index,content&order=chunk_index.asc`),
        embedTexts
      });
      decision = indexed.document;
      embeddedChunks = indexed.embeddedChunks;
    } else {
      decision = await reviewKnowledgeDocument(supabaseRest, {
        documentId: id,
        status,
        reviewer,
        reason: req.body?.reason
      });
    }
    res.json({ document: decision, embeddedChunks, review: { previous: decision.previous, status: decision.review_status, reviewer: decision.reviewer, reason: decision.reason } });
  } catch (error) {
    res.status(error.code || 500).json({ error: error.message });
  }
});

app.post("/api/knowledge/search", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim().slice(0, 1000);
    if (!query) return res.status(400).json({ error: "Enter a search query." });
    let embedding = null;
    try { embedding = await embedText(query); } catch { /* Lexical search remains available. */ }
    const results = embedding
      ? await supabaseRest("rpc/rafa_hybrid_search_knowledge", { method: "POST", body: JSON.stringify({ p_query: query, p_embedding: `[${embedding.join(",")}]`, p_embedding_model: DEFAULT_EMBEDDING_MODEL, p_match_count: 8 }) })
      : await supabaseRest("rpc/rafa_search_knowledge", { method: "POST", body: JSON.stringify({ p_query: query, p_match_count: 8 }) });
    res.json({ results });
  } catch (error) {
    res.status(error.code || 500).json({ error: error.message });
  }
});

// W3.9.7 — the fact register admin surface. Rule 2 made operable: what REFAL
// may state today, what has quietly stopped being stated, and who extended
// which date. The decisions all live in src/factRegister.js and the two audited
// RPCs in supabase/migrations/20261009180000_refal_fact_register.sql;
// dashboard/factRegisterView.js is the adapter between them.
//
// That migration is not applied yet. Every one of these routes answers 503 with
// an explicit "migration not applied" payload in that case, because an empty
// 200 would read as "no facts need review", which is the one wrong answer.
function factRouteError(res, error) {
  res.status(error.code || 500).json({ error: error.message, ...(error.details || {}) });
}

app.get("/api/facts/due", async (req, res) => {
  try { res.json(await dueFacts(supabaseRest, { days: req.query?.days })); }
  catch (error) { factRouteError(res, error); }
});

app.get("/api/facts", async (req, res) => {
  try { res.json(await listFacts(supabaseRest, { status: req.query?.status, topic: req.query?.topic })); }
  catch (error) { factRouteError(res, error); }
});

app.get("/api/facts/:factId/audit", async (req, res) => {
  try { res.json(await factAudit(supabaseRest, req.params.factId)); }
  catch (error) { factRouteError(res, error); }
});

app.post("/api/facts/:factId/reapprove", requireAdmin, async (req, res) => {
  try {
    const reviewer = String(req.dashboardUser?.email || req.dashboardUser?.id || "").trim();
    if (!reviewer) return res.status(403).json({ error: "Your signed-in admin account has no reviewer identity." });
    res.json(await reapproveFact(supabaseRest, {
      factId: req.params.factId,
      reviewer,
      cadenceDays: req.body?.cadenceDays,
      reason: req.body?.reason
    }));
  } catch (error) { factRouteError(res, error); }
});

app.post("/api/facts/:factId/status", requireAdmin, async (req, res) => {
  try {
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (status === "approved") {
      return res.status(400).json({ error: "Use the evidence review action to approve a fact." });
    }
    const actor = String(req.dashboardUser?.email || req.dashboardUser?.id || "").trim();
    if (!actor) return res.status(403).json({ error: "Your signed-in admin account has no reviewer identity." });
    res.json(await setFactStatus(supabaseRest, {
      factId: req.params.factId,
      status,
      actor,
      reason: req.body?.reason
    }));
  } catch (error) { factRouteError(res, error); }
});

app.post("/api/facts/:factId/review", requireAdmin, async (req, res) => {
  try {
    const actor = String(req.dashboardUser?.email || req.dashboardUser?.id || "").trim();
    if (!actor) return res.status(403).json({ error: "Your signed-in admin account has no reviewer identity." });
    res.json(await editFactReview(supabaseRest, {
      factId: req.params.factId,
      sourceDocument: req.body?.sourceDocument,
      sourceRef: req.body?.sourceRef,
      notes: req.body?.notes,
      cadenceDays: req.body?.cadenceDays,
      approvedLanguages: req.body?.approvedLanguages,
      actor,
      reason: req.body?.reason
    }));
  } catch (error) { factRouteError(res, error); }
});

app.get("/api/overview", async (req, res) => {
  const data = await readUsers();
  const events = await readEvents();
  const now = new Date();
  const users = Object.values(data.users || {});
  const usersById = new Map(users.map((user) => [user.id, user]));
  const stats = conversationStats(users, now);
  const status = botStatus(events);

  res.json({
    stats,
    contactActivity: contactActivityStats(users, now),
    status,
    usage: usageEstimate(events, users, now),
    usageAnalytics: aggregateModelUsage(events, users, {
      now,
      clientLabel: (userId, source) => performanceClientLabel(userId, usersById, req.dashboardUser.role === "admin", source)
    }),
    recentConversations: recentConversations(users),
    reports: reportHistory(events),
    voiceNotesToday: countEventsToday(events, "voice_transcribed", now)
  });
});

app.get("/api/openrouter/credits", requireAdmin, async (_req, res) => {
  if (openRouterCreditsCache.expiresAt > Date.now() && openRouterCreditsCache.value) {
    return res.json(openRouterCreditsCache.value);
  }
  const apiKey = process.env.OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.json({ available: false, reason: "not_configured" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      const value = { available: false, reason: "management_key_required" };
      openRouterCreditsCache = { value, expiresAt: Date.now() + 60000 };
      return res.json(value);
    }
    if (!response.ok) return res.json({ available: false, reason: "temporarily_unavailable" });
    const body = await response.json().catch(() => ({}));
    const totalCreditsUsd = finiteNonnegative(body?.data?.total_credits);
    const totalUsageUsd = finiteNonnegative(body?.data?.total_usage);
    if (totalCreditsUsd === null || totalUsageUsd === null) return res.json({ available: false, reason: "temporarily_unavailable" });
    const value = {
      available: true,
      totalCreditsUsd,
      totalUsageUsd,
      remainingCreditsUsd: Math.max(0, totalCreditsUsd - totalUsageUsd),
      checkedAt: new Date().toISOString()
    };
    openRouterCreditsCache = { value, expiresAt: Date.now() + 60000 };
    res.json(value);
  } catch {
    res.json({ available: false, reason: "temporarily_unavailable" });
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/api/leads", async (req, res) => {
  const users = Object.values((await readUsers()).users || {}).map((user) => userSummary(user));
  try {
    const appointments = await supabaseRest("rafa_appointments?select=whatsapp_jid,status,starts_at&order=starts_at.desc&limit=500");
    const latestBooking = new Map();
    for (const appointment of appointments) {
      if (appointment.whatsapp_jid && !latestBooking.has(appointment.whatsapp_jid)) latestBooking.set(appointment.whatsapp_jid, appointment.status || "none");
    }
    for (const user of users) user.bookingStatus = latestBooking.get(user.id) || user.bookingStatus;
  } catch {
    // Leads remain available if the optional booking filter cannot load.
  }
  users.sort((a, b) => dateValue(b.lastMessageAt) - dateValue(a.lastMessageAt));
  res.json({ users });
});

app.get("/api/leads/:id", async (req, res) => {
  const user = await store.getUser(req.params.id, { includeHistory: true });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    user: userSummary(user, { includeHandoverSummary: req.dashboardUser.role === "admin" }),
    history: (user.history || []).slice(-8),
    profile: user.profile || {},
    booking: user.booking || null
  });
});

app.get("/api/conversations", async (req, res) => {
  try {
    const users = Object.values((await readUsers()).users || {});
    const conversations = users.map((user) => {
      const history = Array.isArray(user.history) ? user.history : [];
      const lastTurn = history.at(-1) || {};
      const lastMessage = String(lastTurn.response || lastTurn.message || "");
      return {
        userId: user.id,
        user: userSummary(user, { includeHandoverSummary: req.dashboardUser.role === "admin" }),
        lastMessage,
        lastMessageAt: lastTurn.at || user.updatedAt || "",
        lastMessageDirection: lastTurn.response ? "outgoing" : "incoming",
        messageCount: history.reduce((count, turn) => count + Number(Boolean(turn.message)) + Number(Boolean(turn.response)), 0),
        hasAgentReply: history.some((turn) => Boolean(turn.response)),
        hasCustomerMessage: history.some((turn) => Boolean(turn.message)),
        needsReply: Boolean(lastTurn.message && !lastTurn.response)
      };
    }).filter((item) => item.messageCount > 0)
      .sort((a, b) => dateValue(b.lastMessageAt) - dateValue(a.lastMessageAt));
    res.setHeader("Cache-Control", "no-store");
    res.json({ conversations });
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not load conversations." });
  }
});

app.get("/api/conversations/:userId", async (req, res) => {
  try {
    const user = await store.getUser(req.params.userId, { includeHistory: true });
    if (!user) return res.status(404).json({ error: "Conversation not found." });
    const whatsapp = whatsappController.snapshot();
    const turns = (user.history || []).flatMap((turn) => {
      const rows = [];
      if (turn.message) rows.push({
        id: `${turn.id}:client`,
        turnId: turn.id,
        role: "customer",
        direction: "incoming",
        content: String(turn.message),
        at: turn.at
      });
      if (turn.response) {
        const key = turn.metadata?.whatsapp?.messageKey;
        const sentAt = Date.parse(turn.metadata?.whatsapp?.sentAt || turn.at || "");
        const validKey = key?.fromMe === true && key?.remoteJid === user.id && typeof key?.id === "string" && key.id.length > 0;
        const canEditOnWhatsApp = Boolean(validKey && Number.isFinite(sentAt) && sentAt <= Date.now() && Date.now() - sentAt < 15 * 60 * 1000);
        rows.push({
          id: turn.id,
          role: "assistant",
          direction: "outgoing",
          content: String(turn.response),
          at: turn.at,
          source: turn.source || "whatsapp",
          delivery: turn.metadata?.delivery || null,
          editability: {
            canEditOnWhatsApp,
            canSendCorrection: whatsapp.state === "connected" && whatsapp.managed !== false,
            canSaveLocally: true
          }
        });
      }
      return rows;
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ user: userSummary(user, { includeHandoverSummary: req.dashboardUser.role === "admin" }), turns });
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not load this conversation." });
  }
});

app.get("/api/conversations/:userId/diagnostics", requireAdmin, async (req, res) => {
  try {
    const inspections = await store.listControlledInspections(req.params.userId);
    res.json({ inspections });
  } catch (error) { res.status(Number(error.status) || 502).json({ error: "Controlled diagnostics unavailable." }); }
});

app.delete("/api/conversations/:userId", requireAdmin, authRateLimit, async (req, res) => {
  const userId = String(req.params.userId || "").trim();
  try {
    const result = await deleteConversationTranscript(store, userId);
    if (!result.deleted) return res.status(404).json({ error: "Conversation not found." });
    res.setHeader("Cache-Control", "no-store");
    res.json({ deleted: true, deletedTurns: result.deletedTurns });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || "Could not delete this conversation." });
  }
});

app.post("/api/conversations/:userId/turns/:turnId/edit", requireAdmin, authRateLimit, async (req, res) => {
  const userId = String(req.params.userId || "");
  const turnId = String(req.params.turnId || "");
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!userId || userId.length > 200 || !turnId || !text || text.length > 3900 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return res.status(400).json({ error: "Enter a valid reply under 3900 characters." });
  }

  try {
    const user = await store.getUser(userId, { includeHistory: true });
    const turn = (user?.history || []).find((item) => item.id === turnId);
    if (!user || !turn) return res.status(404).json({ error: "Conversation reply not found." });
    if (!turn.response || turn.source === "self-test") return res.status(400).json({ error: "Only saved customer-facing RAFA replies can be edited." });
    await store.logEvent?.("conversation_reply_admin_edited", {
      contactId: userId,
      turnId,
      actor: req.dashboardUser.email || req.dashboardUser.id,
      action: "edit_customer_facing_reply",
      fields: ["response", "delivery"],
      // Do not persist the reply text in the audit record.
    });

    const whatsapp = turn.metadata?.whatsapp || {};
    const key = whatsapp.messageKey;
    const sentAt = Date.parse(whatsapp.sentAt || turn.at || "");
    const validKey = key?.fromMe === true && key?.remoteJid === userId && typeof key?.id === "string" && key.id.length > 0;
    const canEditOnWhatsApp = Boolean(validKey && Number.isFinite(sentAt) && sentAt <= Date.now() && Date.now() - sentAt < 15 * 60 * 1000);
    const controllerState = whatsappController.snapshot();
    const canDeliverViaDashboard = controllerState.state === "connected" && controllerState.managed !== false;
    const mode = canEditOnWhatsApp ? "platform_edit" : "correction_resend";
    const outboundText = mode === "platform_edit" ? text : `Correction from RAFA: ${text}`;

    let delivery;
    try {
      delivery = canDeliverViaDashboard
        ? await whatsappController.deliverReplyEdit({ userId, text, mode, messageKey: canEditOnWhatsApp ? key : null })
        : await deliverReplyEditViaLocalWorker({ userId, text, mode, messageKey: canEditOnWhatsApp ? key : null });
    } catch (deliveryError) {
      const saved = await store.updateHistoryTurn(userId, turnId, {
        response: text,
        metadata: {
          delivery: {
            action: "correction_resend",
            status: "failed",
            edited: true,
            message: "Saved in the dashboard transcript. WhatsApp was not changed."
          },
          editability: { canEditOnWhatsApp: false }
        }
      });
      return res.json({ turn: conversationReplyTurn(saved), delivery: { action: "local_update", status: "failed", edited: true, dashboardOnly: true, message: deliveryError.message || "WhatsApp delivery failed." } });
    }

    if (mode === "platform_edit") {
      try {
        const saved = await store.updateHistoryTurn(userId, turnId, {
          response: text,
          metadata: {
            delivery: { action: mode, status: "sent", edited: true, canEditOnWhatsApp: false },
            editability: { canEditOnWhatsApp: false }
          }
        });
        return res.json({ turn: conversationReplyTurn(saved), delivery: { action: mode, status: "sent", edited: true } });
      } catch {
        return res.status(502).json({ error: "WhatsApp accepted the edit, but RAFA could not update its saved transcript. Refresh the conversation to verify it." });
      }
    }

    const correction = await store.addHistory(userId, "", outboundText, {
      automated: false,
      source: "dashboard_correction",
      metadata: {
        delivery: { action: mode, status: "sent", resent: true },
        whatsapp: {
          ...(delivery?.key ? { messageKey: delivery.key } : {}),
          sentAt: new Date().toISOString()
        }
      }
    });
    return res.json({ turn: conversationReplyTurn(correction), delivery: { action: mode, status: "sent", resent: true } });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || "Could not deliver this reply update." });
  }
});

app.patch("/api/leads/:id/qualification", requireAdmin, async (req, res) => {
  const status = req.body?.status;
  if (!["unreviewed", "qualified", "not_qualified"].includes(status)) {
    return res.status(400).json({ error: "Qualification must be unreviewed, qualified, or not_qualified." });
  }

  try {
    const existing = await store.getUser(req.params.id, { includeHistory: false });
    if (!existing) return res.status(404).json({ error: "Lead not found." });
    const qualification = {
      status,
      reviewedAt: status === "unreviewed" ? null : new Date().toISOString(),
      reviewedBy: status === "unreviewed" ? null : (req.dashboardUser.email || req.dashboardUser.id)
    };
    await store.updateUser(req.params.id, (draft) => {
      draft.profile = { ...(draft.profile || {}), qualification };
    });
    await store.logEvent?.("lead_qualification_admin_updated", { contactId: req.params.id, actor: req.dashboardUser.email || req.dashboardUser.id, action: "update_qualification", fields: ["status"] });
    const saved = await store.getUser(req.params.id, { includeHistory: false });
    res.json({ ok: true, user: userSummary(saved) });
  } catch {
    res.status(500).json({ error: "Could not save the lead qualification." });
  }
});

app.get("/api/bookings", async (_req, res) => {
  const rows = await readBookingRows();
  const bookings = rows.map((appointment) => {
    const contact = appointment.contact || {};
    const user = { id: appointment.whatsapp_jid, phone: contact.phone, profile: contact.profile || {}, whatsapp: contact.whatsapp || {} };
    return {
      id: appointment.id,
      userId: appointment.whatsapp_jid,
      phone: displayPhone(user),
      name: displayName(user),
      status: appointment.status,
      start: appointment.starts_at,
      end: appointment.ends_at,
      timezone: appointment.timezone,
      purpose: appointment.purpose,
      reviewReason: appointment.review_reason || "",
      reviewedAt: appointment.reviewed_at || "",
      reviewedBy: appointment.reviewed_by || "",
      eventId: appointment.google_event_id || "",
      eventUrl: appointment.google_event_url || "",
      meetUrl: appointment.google_meet_url || "",
      bookedAt: appointment.created_at,
      reminders: (appointment.reminders || []).map((reminder) => ({
        id: reminder.id,
        kind: reminder.reminder_kind,
        channel: reminder.channel,
        dueAt: reminder.due_at,
        status: reminder.status,
        sentAt: reminder.sent_at,
        lastError: reminder.last_error
      }))
    };
  });
  res.json({ bookings });
});

app.get("/api/notifications", requireAdmin, async (_req, res) => {
  try { res.json({ notifications: await store.listNotifications() }); }
  catch (error) { res.status(502).json({ error: String(error?.message || "Could not load notification delivery status.").slice(0, 250) }); }
});

app.get("/api/handovers/summary", requireAdmin, async (_req, res) => {
  try {
    const [openRows, problemRows] = await Promise.all([
      readAllSupabaseRows(withStableCreatedAtIdOrder("rafa_handovers?select=id,contact_id&status=in.(open,acknowledged)&order=created_at.desc")),
      readAllSupabaseRows(withStableIdOrder("refal_handover_delivery?select=id&status=in.(retry,failed)", "updated_at"))
    ]);
    const openCount = countUniqueHandoverContacts(openRows);
    const deliveryIssueCount = problemRows.length;
    res.setHeader("Cache-Control", "no-store");
    res.json({ openCount, deliveryIssueCount, totalCount: openCount + deliveryIssueCount, capped: false });
  } catch (error) { res.status(502).json({ error: String(error?.message || "Could not load notification count.").slice(0, 250) }); }
});

app.get("/api/handovers", requireAdmin, async (_req, res) => {
  try {
    const handovers = await readAllSupabaseRows(withStableCreatedAtIdOrder("rafa_handovers?select=id,department,priority,status,summary,source_turn_id,created_at,contact:rafa_contacts!rafa_handovers_contact_id_fkey(id,whatsapp_jid,phone,profile,whatsapp)&status=in.(open,acknowledged)&order=created_at.desc"));
    const ids = handovers.map((item) => item.id).filter((id) => /^[0-9a-f-]{36}$/i.test(String(id || "")));
    let jobs = [];
    let notificationSchemaReady = true;
    if (ids.length) {
      try {
        const idBatches = [];
        for (let index = 0; index < ids.length; index += 50) idBatches.push(ids.slice(index, index + 50));
        jobs = (await mapWithConcurrency(idBatches, (batch) => readAllSupabaseRows(withStableCreatedAtIdOrder(`rafa_notification_jobs?select=id,handover_id,kind,channel,recipient,payload,status,created_at,last_error&kind=in.(admin_followup,handover_review)&handover_id=in.(${batch.join(",")})&order=created_at.desc`)))).flat();
      }
      catch (error) {
        if (!/handover_id|admin_followup|handover_review|schema cache|column/i.test(String(error?.message || ""))) throw error;
        notificationSchemaReady = false;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ notificationSchemaReady, handovers: handovers.map((row) => {
      const contact = row.contact || {};
      const profile = contact.profile || {};
      const user = { profile, whatsapp: contact.whatsapp || {} };
      return {
        id: row.id,
        department: row.department,
        priority: row.priority,
        status: row.status,
        summary: row.summary || {},
        createdAt: row.created_at,
        language: normalizeHandoverLanguage(row.summary?.language || profile.preferredLanguage || profile.language),
        contact: {
          id: contact.id,
          userId: contact.whatsapp_jid,
          name: displayName(user),
          email: normalizeEmail(profile.email),
          phone: displayPhone({ id: contact.whatsapp_jid, phone: contact.phone, profile, whatsapp: contact.whatsapp || {} }),
          whatsappJid: contact.whatsapp_jid || ""
        },
        drafts: jobs.filter((job) => job.handover_id === row.id && job.kind === "admin_followup"),
        alerts: jobs.filter((job) => job.handover_id === row.id && job.kind === "handover_review").map(({ id, status, created_at, last_error }) => ({ id, status, createdAt: created_at, lastError: last_error || "" }))
      };
    }) });
  } catch (error) { res.status(502).json({ error: String(error?.message || "Could not load specialist follow-ups.").slice(0, 250) }); }
});

app.patch("/api/handovers/:id", requireAdmin, authRateLimit, async (req, res) => {
  const status = String(req.body?.status || "");
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id) || !["acknowledged", "resolved"].includes(status)) return res.status(400).json({ error: "Choose a valid handover status." });
  try {
    const result = await syncHandoverStatus({
      handoverId: req.params.id,
      status,
      readTarget: async (id) => {
        const rows = await supabaseRest(`rafa_handovers?id=eq.${encodeURIComponent(id)}&select=id,contact_id,department,status&limit=1`);
        return rows[0] || null;
      },
      readGroup: async (target) => {
        const scope = /^[0-9a-f-]{36}$/i.test(String(target.contact_id || ""))
          ? `contact_id=eq.${encodeURIComponent(target.contact_id)}`
          : `id=eq.${encodeURIComponent(target.id)}`;
        return supabaseRest(`rafa_handovers?${scope}&select=id,contact_id,department,status`);
      },
      readDelivery: (ids) => {
        if (!ids.length) return Promise.resolve([]);
        const list = ids.map((id) => encodeURIComponent(id)).join(",");
        return supabaseRest(`refal_handover_delivery?handover_id=in.(${list})&select=handover_id,status,acknowledged_at,closed_at,closure_reason`);
      },
      cancelActiveReviewNotifications: (ids, changedAt) => {
        const list = ids.map((id) => encodeURIComponent(id)).join(",");
        return supabaseRest(`rafa_notification_jobs?handover_id=in.(${list})&kind=eq.handover_review&status=in.(queued,processing)`, {
          method: "PATCH",
          body: JSON.stringify({ status: "cancelled", locked_at: null, last_error: "Handover is closed.", updated_at: changedAt })
        });
      },
      updateActive: (rows, nextStatus, changedAt) => {
        const ids = rows.map((row) => encodeURIComponent(row.id)).join(",");
        return supabaseRest(`rafa_handovers?id=in.(${ids})&status=in.(open,acknowledged)&select=id,contact_id,department,status`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: nextStatus, resolved_at: nextStatus === "resolved" ? changedAt : null })
        });
      },
      upsertDelivery: (rows) => supabaseRest("refal_handover_delivery?on_conflict=handover_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows)
      })
    });
    await logDashboardEvent("handover_admin_status_updated", { handoverId: req.params.id, groupedRequestCount: result.reconciledCount, status, actor: req.dashboardUser.email || req.dashboardUser.id });
    res.json(result);
  } catch (error) {
    const statusCode = error instanceof HandoverStatusSyncError ? error.status : 502;
    res.status(statusCode).json({ error: String(error?.message || "Could not update specialist request.").slice(0, 250) });
  }
});

app.post("/api/handovers/:id/follow-ups", requireAdmin, authRateLimit, async (req, res) => {
  const handoverId = String(req.params.id || "");
  const channel = String(req.body?.channel || "");
  const text = String(req.body?.text || "").trim();
  const subject = String(req.body?.subject || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(handoverId) || !["whatsapp", "email"].includes(channel) || !text || text.length > 4000 || subject.length > 180) return res.status(400).json({ error: "Choose a channel and enter a short customer follow-up draft." });
  try {
    const rows = await supabaseRest(`rafa_handovers?id=eq.${encodeURIComponent(handoverId)}&status=in.(open,acknowledged)&select=id,contact:rafa_contacts!rafa_handovers_contact_id_fkey(id,whatsapp_jid,profile)&limit=1`);
    const contact = rows[0]?.contact;
    if (!contact) return res.status(404).json({ error: "Open specialist request not found." });
    await assertSpecialistFollowUpConsent(contact.id);
    const profile = contact.profile || {};
    const recipient = String(req.body?.recipient || (channel === "email" ? profile.email : contact.whatsapp_jid) || "").trim();
    const validRecipient = channel === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) : /^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(recipient);
    if (!validRecipient) return res.status(400).json({ error: channel === "email" ? "Add the customer’s email address before saving this draft." : "The customer has no usable WhatsApp address." });
    const notification = await store.createNotification({
      kind: "admin_followup", handoverId, channel, recipient, status: "draft",
      idempotencyKey: `handover:${handoverId}:draft:${crypto.randomUUID()}`,
      payload: channel === "email" ? { subject: subject || "A follow-up from Refalco Group", text } : { text }
    });
    await logDashboardEvent("handover_followup_draft_saved", { handoverId, channel, actor: req.dashboardUser.email || req.dashboardUser.id });
    res.status(201).json({ notification: notification.notification || notification });
  } catch (error) { res.status(error.statusCode || 502).json({ error: String(error?.message || "Could not save the follow-up draft.").slice(0, 250) }); }
});

app.post("/api/notifications/:id/send", requireAdmin, authRateLimit, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid draft ID." });
  try {
    const drafts = await supabaseRest(`rafa_notification_jobs?id=eq.${encodeURIComponent(req.params.id)}&kind=eq.admin_followup&status=eq.draft&select=id,handover_id&limit=1`);
    if (!drafts[0]) return res.status(409).json({ error: "This follow-up is not a saved draft." });
    const handovers = await supabaseRest(`rafa_handovers?id=eq.${encodeURIComponent(drafts[0].handover_id)}&select=contact_id&limit=1`);
    if (!handovers[0]?.contact_id) return res.status(403).json({ error: "Specialist follow-up consent is required." });
    await assertSpecialistFollowUpConsent(handovers[0].contact_id);
    const notification = await store.queueNotificationDraft(req.params.id);
    await logDashboardEvent("handover_followup_approved", { notificationId: notification.id, handoverId: notification.handover_id, channel: notification.channel, actor: req.dashboardUser.email || req.dashboardUser.id });
    res.json({ notification });
  } catch (error) { res.status(error.statusCode || (/not a saved draft/i.test(error.message) ? 409 : 502)).json({ error: String(error?.message || "Could not queue this approved follow-up.").slice(0, 250) }); }
});

app.post("/api/notifications/:id/retry", requireAdmin, authRateLimit, async (req, res) => {
  try { res.json({ notification: await store.retryNotification(req.params.id) }); }
  catch (error) { res.status(/not retryable/i.test(error.message) ? 409 : 502).json({ error: String(error?.message || "Could not retry notification.").slice(0, 250) }); }
});

app.get("/api/blocks", requireAdmin, async (_req, res) => {
  try { res.json({ blocks: await store.listContactBlocks() }); }
  catch (error) { res.status(502).json({ error: String(error?.message || "Could not load blocked contacts.").slice(0, 250) }); }
});

app.post("/api/blocks", requireAdmin, authRateLimit, async (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const reason = String(req.body?.reason || "").trim();
  const category = String(req.body?.category || "other");
  if (!/^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(userId) || !reason || reason.length > 500 || !["harassment", "spam", "threat", "other"].includes(category)) return res.status(400).json({ error: "Enter a valid WhatsApp ID, a reason, and a block category." });
  try {
    const block = await store.blockContact({ userId, reason, category, createdBy: req.dashboardUser.email || req.dashboardUser.id });
    res.status(201).json({ block });
  } catch (error) { res.status(/already blocked/i.test(error.message) ? 409 : 502).json({ error: String(error?.message || "Could not block contact.").slice(0, 250) }); }
});

app.patch("/api/blocks/:id", requireAdmin, authRateLimit, async (req, res) => {
  try {
    const block = await store.unblockContact(req.params.id, { reviewer: req.dashboardUser.email || req.dashboardUser.id, reason: String(req.body?.reason || "").trim().slice(0, 500) });
    res.json({ block });
  } catch (error) { res.status(/inactive/i.test(error.message) ? 409 : 502).json({ error: String(error?.message || "Could not unblock contact.").slice(0, 250) }); }
});

app.post("/api/bookings/:id/review", requireAdmin, authRateLimit, async (req, res) => {
  const action = String(req.body?.action || "");
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  try {
    if (action === "approve") {
      const result = await calendarOnboarding.review({ action, appointmentId: req.params.id, reviewer: req.dashboardUser.email || req.dashboardUser.id });
      let notificationError = result.reminderError || "";
      try {
        const when = new Intl.DateTimeFormat("en-GB", { timeZone: result.policy.timezone, dateStyle: "full", timeStyle: "short" }).format(result.event.start?.dateTime ? new Date(result.event.start.dateTime) : new Date(result.appointment.starts_at));
        const contact = await store.getUser(result.appointment.whatsapp_jid, { includeHistory: true });
        const lastCustomerText = contact?.history?.at(-1)?.message || "";
        const arabic = /[\u0600-\u06ff]/.test(lastCustomerText);
        const linkIsDue = Date.parse(result.appointment.starts_at) - Date.now() <= 60 * 60 * 1000;
        const meetLink = result.event.meetLink || "";
        const reminderCopy = result.reminderError
          ? (arabic ? " سيتابع فريق الشركة إرسال رابط الاجتماع معك." : " The Refalco Group team will follow up with your meeting link.")
          : (arabic ? " سنرسل رابط Google Meet قبل الاجتماع بساعة." : " The Google Meet link will be sent one hour before the meeting.");
        const text = arabic
          ? `تم تأكيد موعدك مع الشركة يوم ${when} (${result.policy.timezone}).${linkIsDue && meetLink ? ` رابط Google Meet: ${meetLink}` : reminderCopy}`
          : `Your Refalco Group appointment is confirmed for ${when} (${result.policy.timezone}).${linkIsDue && meetLink ? ` Google Meet: ${meetLink}` : reminderCopy}`;
        await enqueueAppointmentMessage(result.appointment, "confirmed", text, result.appointment.reviewed_at || new Date().toISOString());
      } catch (error) { notificationError = String(error?.message || "WhatsApp notification queue failed").slice(0, 240); }
      await store.logEvent?.("appointment_admin_approved", { appointmentId: req.params.id, reviewer: req.dashboardUser.email || req.dashboardUser.id, notificationError });
      return res.json({ ok: true, status: "confirmed", notificationError });
    }
    if (["cancel", "reschedule"].includes(action)) {
      const appointment = await store.getAppointment(req.params.id);
      if (!appointment) return res.status(404).json({ error: "Appointment was not found." });
      const nextStatus = action === "cancel" ? "cancelled" : "rescheduled";
      const result = await calendarOnboarding.review({ action, appointmentId: appointment.id, reviewer: req.dashboardUser.email || req.dashboardUser.id, reason });
      const updated = result.updated;
      let notificationError = "";
      try {
        const contact = await store.getUser(appointment.whatsapp_jid, { includeHistory: true });
        const arabic = /[\u0600-\u06ff]/.test(contact?.history?.at(-1)?.message || "");
        const text = nextStatus === "cancelled"
          ? (arabic ? "تم إلغاء موعدك مع الشركة." : "Your Refalco Group appointment has been cancelled.")
          : (arabic ? "يرغب فريق الشركة في تغيير موعدك. أرسل اليوم والوقت الجديدين وسنرسلهما للمراجعة." : "The Refalco Group team needs to reschedule your meeting. Send a new day and time and we’ll submit it for review.");
        await enqueueAppointmentMessage(appointment, nextStatus, text, updated.reviewed_at || new Date().toISOString());
      } catch (error) { notificationError = String(error?.message || "WhatsApp notification queue failed").slice(0, 240); }
      await store.logEvent?.(`appointment_${nextStatus}`, { appointmentId: appointment.id, reviewer: req.dashboardUser.email || req.dashboardUser.id, notificationError });
      return res.json({ ok: true, status: updated.status, notificationError });
    }
    if (action !== "reject" || !reason) return res.status(400).json({ error: "Choose approve or provide a short reason when rejecting." });
    const appointment = await store.getAppointment(req.params.id);
    if (!appointment || appointment.status !== "pending_review") return res.status(409).json({ error: "This appointment is no longer awaiting review." });
    const updated = await store.updateAppointment(req.params.id, { status: "rejected", reviewReason: reason, reviewedAt: new Date().toISOString(), reviewedBy: req.dashboardUser.email || req.dashboardUser.id });
    await store.updateUser(appointment.whatsapp_jid, (draft) => { draft.booking = { status: "awaiting_details", startedAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID(), purpose: appointment.purpose }; });
    let notificationError = "";
    try {
      const contact = await store.getUser(appointment.whatsapp_jid, { includeHistory: true });
      const arabic = /[\u0600-\u06ff]/.test(contact?.history?.at(-1)?.message || "");
      let alternatives = [];
      let bookingPolicy;
      try {
        bookingPolicy = await store.getBookingPolicy();
        alternatives = await suggestAvailableTimes(bookingPolicy, { count: 3 });
      }
      catch (availabilityError) { await store.logEvent?.("appointment_alternatives_lookup_error", { appointmentId: appointment.id, message: String(availabilityError?.message || "Calendar lookup failed").slice(0, 200) }); }
      const times = bookingPolicy ? alternatives.map(({ start }) => formatBookingTime(start, bookingPolicy, arabic ? "arabic" : "english")) : [];
      const rejectionText = arabic
        ? `نعتذر، تعذر اعتماد هذا الوقت.${times.length ? ` هذه أوقات بديلة متاحة بعد التحقق: ${times.join("، ")}.` : " أرسل يومًا ووقتًا آخر وسأطلب من الفريق مراجعته."} ${times.length ? "اختر وقتًا وسأرسله للمراجعة." : ""}`
        : `Sorry, we can’t accept that time.${times.length ? ` These available alternatives were checked: ${times.join(", ")}. Choose one and I’ll send it for review.` : " Please send another suitable day and time, and I’ll ask the team to review it."}`;
      await enqueueAppointmentMessage(updated, "rejected", rejectionText, updated.reviewed_at || new Date().toISOString());
    } catch (error) { notificationError = String(error?.message || "WhatsApp notification queue failed").slice(0, 240); }
    await store.logEvent?.("appointment_admin_rejected", { appointmentId: req.params.id, reviewer: req.dashboardUser.email || req.dashboardUser.id, reason, notificationError });
    return res.json({ ok: true, status: updated.status, notificationError });
  } catch (error) {
    const message = String(error?.message || "Appointment review failed").slice(0, 400);
    const status = /pending|reviewed|found/i.test(message) ? 409 : 502;
    return res.status(status).json({ error: message });
  }
});

async function enqueueAppointmentMessage(appointment, expectedAppointmentStatus, text, revisionKey) {
  return store.createNotification({
    appointmentId: appointment.id,
    kind: "customer_message",
    recipient: appointment.whatsapp_jid,
    expectedAppointmentStatus,
    idempotencyKey: `${appointment.id}:${expectedAppointmentStatus}:${revisionKey}:customer-notice`.slice(0, 240),
    payload: { text }
  });
}

async function readBookingRows() {
  const baseSelect = "id,whatsapp_jid,status,starts_at,ends_at,timezone,purpose,review_reason,reviewed_at,reviewed_by,google_event_id,google_event_url,created_at,contact:rafa_contacts!rafa_appointments_contact_id_fkey(phone,profile,whatsapp),reminders:rafa_reminder_jobs(id,reminder_kind,channel,recipient,due_at,status,sent_at,last_error)";
  const withMeetSelect = baseSelect.replace("google_event_url,", "google_event_url,google_meet_url,");
  try {
    return await supabaseRest(`rafa_appointments?select=${withMeetSelect}&order=starts_at.desc&limit=500`);
  } catch (error) {
    if (!/google_meet_url/i.test(error.message || "")) throw error;
    const rows = await supabaseRest(`rafa_appointments?select=${baseSelect}&order=starts_at.desc&limit=500`);
    return rows.map((appointment) => ({ ...appointment, google_meet_url: "" }));
  }
}

app.get("/api/bookings/readiness", async (_req, res) => {
  try {
    const policy = await store.getBookingPolicy();
    const valid = policy ? (() => { try { return validateBookingPolicy(policy); } catch { return null; } })() : null;
    const access = calendarReadiness.get(valid?.calendarId);
    const credentialsReady = workerCredentialsReady();
    const policyReady = isBookingPolicyReady(valid);
    res.json({
      active: credentialsReady && policyReady && Boolean(access), policy: valid,
      calendarAccessVerified: Boolean(access), calendarAccessCheckedAt: access?.checkedAt || null,
      calendarCredentials: credentialsReady,
      calendarAuthorizationStatus: calendarOnboarding.status
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post("/api/knowledge/search/preview", requireAdmin, async (req, res) => {
  try {
    const preview = await previewKnowledgeAcrossLanguages(async (query) => {
      let embedding = null;
      try { embedding = await embedText(query); } catch { /* Approved lexical retrieval remains available. */ }
      return embedding
        ? await supabaseRest("rpc/rafa_hybrid_search_knowledge", { method: "POST", body: JSON.stringify({ p_query: query, p_embedding: `[${embedding.join(",")}]`, p_embedding_model: DEFAULT_EMBEDDING_MODEL, p_match_count: 8 }) })
        : await supabaseRest("rpc/rafa_search_knowledge", { method: "POST", body: JSON.stringify({ p_query: query, p_match_count: 8 }) });
    }, req.body?.queries);
    res.json(preview);
  } catch (error) { res.status(error.code || 500).json({ error: error.message }); }
});

app.patch("/api/knowledge/:id/archive", requireAdmin, async (req, res) => {
  try {
    const result = await setKnowledgeSourceArchived(supabaseRest, {
      sourceId: requireUuid(req.params.id), archived: req.body?.archived,
      actor: req.dashboardUser?.email || req.dashboardUser?.id, reason: req.body?.reason
    });
    await logDashboardEvent(result.archived ? "knowledge_source_archived" : "knowledge_source_restored", {
      sourceId: result.source.id, displayName: result.source.display_name, actor: result.actor, reason: result.reason
    });
    res.json(result);
  } catch (error) { res.status(error.code || 500).json({ error: error.message }); }
});

app.post("/api/bookings/calendar-oauth/start", requireAdmin, authRateLimit, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const started = await calendarOnboarding.start();
    res.json(started);
  } catch (error) { res.status(400).json({ error: error.message || "Calendar authorization could not start." }); }
});

app.post("/api/bookings/test-calendar", requireAdmin, async (_req, res) => {
  try {
    const policy = validateBookingPolicy(await store.getBookingPolicy());
    const access = await calendarOnboarding.verify(policy);
    calendarReadiness.markVerified(access);
    res.json({ access });
  } catch (error) {
    calendarReadiness.invalidate();
    const missingCredentials = /credentials are not configured/i.test(error.message);
    res.status(missingCredentials ? 503 : 502).json({ error: error.message });
  }
});

app.put("/api/bookings/policy", requireAdmin, async (req, res) => {
  try {
    const policy = validateBookingPolicy(req.body?.policy);
    const saved = await store.updateBookingPolicy(policy);
    calendarReadiness.invalidate();
    res.json({ policy: saved, active: false, calendarAccessVerified: false });
  } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});

app.get("/api/reports", async (_req, res) => {
  try {
    res.json({ reports: reportHistory(await readEvents()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reports/download", requireAdmin, async (_req, res) => {
  let outputDir;
  try {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "rafa-report-"));
    const report = await generateConversationReport({
      store,
      outputDir,
      now: new Date()
    });
    await store.logEvent("report_generated", {
      reportDate: path.basename(report.filePath).replace("whatsapp-conversations-", "").replace(".xlsx", ""),
      userCount: report.userCount,
      rowCount: report.rowCount
    });
    res.download(report.filePath, path.basename(report.filePath), (error) => {
      cleanupTempReport(outputDir).catch(() => {});
      if (error && !res.headersSent) res.status(500).end();
    });
  } catch (error) {
    if (outputDir) await cleanupTempReport(outputDir);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/agent/state", async (req, res) => {
  try {
    const isAdmin = req.dashboardUser.role === "admin";
    const [sessions, memories] = await Promise.all([
      listAgentSessions(req.dashboardUser.id, isAdmin),
      isAdmin ? listAgentMemories() : Promise.resolve([])
    ]);
    const current = sessions[0] ? await getAgentSession(sessions[0].id, req.dashboardUser) : { session: null, messages: [] };
    res.json({ sessions, memories, ...current });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/agent/sessions", async (req, res) => {
  try {
    const session = await createAgentSession(req.body || {}, req.dashboardUser.id, req.dashboardUser.role === "admin");
    res.json({ session, messages: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/agent/sessions/:id", async (req, res) => {
  try {
    const result = await getAgentSession(req.params.id, req.dashboardUser);
    if (!result.session) return res.status(404).json({ error: "Chat session not found." });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/agent/sessions/:id", async (req, res) => {
  try {
    const existing = await getAgentSession(req.params.id, req.dashboardUser);
    if (!existing.session) return res.status(404).json({ error: "Chat session not found." });
    if (req.dashboardUser.role !== "admin" && (req.body?.model !== undefined || req.body?.memoryEnabled !== undefined)) {
      return res.status(403).json({ error: "Only administrators can change agent settings." });
    }
    const session = await updateAgentSession(req.params.id, req.body || {});
    if (!session) return res.status(404).json({ error: "Chat session not found." });
    res.json({ session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/agent/sessions/:id", async (req, res) => {
  try {
    const existing = await getAgentSession(req.params.id, req.dashboardUser);
    if (!existing.session) return res.status(404).json({ error: "Chat session not found." });
    await supabaseRest(`rafa_agent_sessions?id=eq.${encodeURIComponent(req.params.id)}`, { method: "DELETE" });
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/agent/chat", limitAgentChat, async (req, res) => {
  const streamEvent = (event) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const text = String(req.body?.message || "").trim();
    if (!text) return res.status(400).json({ error: "Message is required." });
    if (text.length > 4000) return res.status(413).json({ error: "Message must be 4,000 characters or fewer." });

    let session = null;
    if (req.body?.sessionId) {
      session = (await getAgentSession(String(req.body.sessionId), req.dashboardUser)).session;
      if (!session) return res.status(404).json({ error: "Chat session not found." });
    }
    if (!session) session = await createAgentSession({ title: titleFromMessage(text) }, req.dashboardUser.id, req.dashboardUser.role === "admin");

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    await addAgentMessage(session.id, {
      role: "user",
      content: text,
      metadata: { source: "dashboard" }
    });

    const { messages } = await getAgentSession(session.id, req.dashboardUser);

    streamEvent({ type: "meta", session });

    const memoryCandidate = req.dashboardUser.role === "admin" ? extractMemory(text) : null;
    if (memoryCandidate) {
      await createAgentMemory({
        label: memoryCandidate.label,
        content: memoryCandidate.content,
        sourceSessionId: session.id,
        pinned: true
      });
    }

    let reply = "";
    let evidence = [];
    const generationTimeout = setTimeout(() => controller.abort(), 90000);
    try {
      reply = await askDashboardAgent({
        text,
        messages,
        model: session.model,
        memories: req.dashboardUser.role === "admin" && session.memory_enabled ? await relevantAgentMemories(text) : [],
        evidence: evidence = await dashboardKnowledge(text),
        signal: controller.signal,
        onUsage: (usage) => logOpenRouterUsage("dashboard", req.dashboardUser.id, usage),
        onToken: (token) => streamEvent({ type: "token", token })
      });
    } catch (error) {
      reply = dashboardFailureReply({ text, evidence, error });
      streamEvent({ type: "token", token: reply });
    } finally {
      clearTimeout(generationTimeout);
    }

    const assistantMessage = await addAgentMessage(session.id, {
      role: "assistant",
      content: reply,
      metadata: { model: session.model }
    });

    if (messages.length <= 1) {
      try {
        session = await updateAgentSession(session.id, { title: titleFromMessage(text) });
      } catch {
        session = { ...session, title: titleFromMessage(text) };
      }
    }

    const [freshResult, sessionsResult, memoriesResult] = await Promise.allSettled([
      getAgentSession(session.id, req.dashboardUser),
      listAgentSessions(req.dashboardUser.id, req.dashboardUser.role === "admin"),
      req.dashboardUser.role === "admin" ? listAgentMemories() : Promise.resolve([])
    ]);

    streamEvent({
      type: "complete",
      session: freshResult.status === "fulfilled" ? freshResult.value.session : session,
      messages: freshResult.status === "fulfilled" ? freshResult.value.messages : [...messages, assistantMessage],
      ...(sessionsResult.status === "fulfilled" ? { sessions: sessionsResult.value } : {}),
      ...(memoriesResult.status === "fulfilled" ? { memories: memoriesResult.value } : {}),
      reply
    });
    res.end();
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error("Dashboard agent chat failed", { requestId, error });
    const message = "The assistant could not complete that request. Please try again.";
    if (!res.headersSent) return res.status(500).json({ error: message, requestId });
    streamEvent({ type: "error", error: message, requestId });
    res.end();
  }
});

app.post("/api/agent/memories", requireAdmin, async (req, res) => {
  try {
    const memory = await createAgentMemory(req.body || {});
    res.json({ memory, memories: await listAgentMemories() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/agent/memories/:id", requireAdmin, async (req, res) => {
  try {
    await supabaseRest(`rafa_agent_memories?id=eq.${encodeURIComponent(req.params.id)}`, { method: "DELETE" });
    res.json({ deleted: true, memories: await listAgentMemories() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const distPath = path.join(dashboardRoot, "dist");
if (fs.existsSync(distPath)) {
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    }
    next();
  });
  app.use(express.static(distPath, {
    etag: false,
    lastModified: false,
    maxAge: 0
  }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(distPath, "index.html")));
} else {
  app.get("/", (_req, res) => {
    res.status(200).send("Dashboard API is running. Run npm run build in dashboard/ to serve the React app.");
  });
}

app.listen(port, () => {
  console.log(`Dashboard running on http://127.0.0.1:${port}`);
});

function requireUuid(value) {
  const id = String(value || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw httpError(400, "Invalid resource id.");
  return id;
}

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function storeKnowledgeRevision(sourceId, document, languageCode, metadata = {}) {
  const content = normalizeKnowledgeContent(document.content).slice(0, 250_000);
  const contentSha256 = crypto.createHash("sha256").update(content).digest("hex");
  const result = await supabaseRest("rpc/rafa_store_knowledge_revision", {
    method: "POST",
    body: JSON.stringify({
      p_source_id: sourceId,
      p_title: document.title,
      p_content: content,
      p_content_sha256: contentSha256,
      p_language_code: languageCode,
      p_chunks: document.chunks,
      p_metadata: metadata,
      // Dashboard edits and imports require a separate administrator decision.
      // The generated corpus uses its own explicit approved-ingestion path in
      // src/corpusIngest.js and remains unchanged.
      p_review_status: "pending",
      p_approved_by: null
    })
  });
  return result;
}

async function indexKnowledgeDocument(documentId) {
  try {
    const chunks = await supabaseRest(`rafa_knowledge_chunks?document_id=eq.${documentId}&select=chunk_index,content&order=chunk_index.asc`);
    const vectors = await embedTexts(chunks.map((chunk) => chunk.content));
    const embeddedChunks = await supabaseRest("rpc/rafa_store_knowledge_embeddings", {
      method: "POST",
      body: JSON.stringify({
        p_document_id: documentId,
        p_model: DEFAULT_EMBEDDING_MODEL,
        p_embeddings: chunks.map((chunk, index) => ({ chunk_index: chunk.chunk_index, embedding: vectors[index] }))
      })
    });
    return { embeddedChunks, embeddingWarning: "" };
  } catch (error) {
    return { embeddedChunks: 0, embeddingWarning: String(error.message || "Embedding failed").slice(0, 240) };
  }
}

async function readUsers() {
  return store.toJsonData({ includeHistory: true });
}

async function readEvents() {
  if (store.listEvents) return store.listEvents({ limit: 5000 });
  return [];
}

// PostgREST commonly caps a response at 1,000 rows. Queue pages and badge
// counts must inspect the same complete unresolved ledger, not a silent first
// page; callers fail as a whole if any page fails so partial data is never
// presented as a reconciled total.
async function readAllSupabaseRows(path) {
  return readAllRows((query, range) => supabaseRest(query, { headers: { Range: range } }), path);
}

async function logDashboardEvent(event, fields = {}) {
  if (store.logEvent) {
    await store.logEvent(event, fields);
    return;
  }
  await supabaseRest("rafa_events", {
    method: "POST",
    body: JSON.stringify({ event, fields, at: new Date().toISOString() })
  });
}

async function stopLocalWhatsAppWorkers() {
  if (process.platform !== "win32") throw new Error("Stopping external RAFA workers is only configured for this Windows dashboard host.");
  const script = [
    "$items = Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'src/bot.js' };",
    "$pids = @();",
    "foreach ($item in $items) {",
    "  $pids += [int]$item.ProcessId;",
    "  Stop-Process -Id $item.ProcessId -Force;",
    "}",
    "$pids | ConvertTo-Json -Compress"
  ].join(" ");
  const output = await execFileText("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: botRoot,
    timeout: 10000
  });
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((pid) => Number.isInteger(pid));
}

async function deliverReplyEditViaLocalWorker(payload) {
  const token = process.env.RAFA_LOCAL_CONTROL_TOKEN || process.env.RAFA_DASHBOARD_SUPABASE_SECRET || process.env.RAFA_API_SECRET;
  const port = Number(process.env.RAFA_LOCAL_CONTROL_PORT || 8792);
  if (!token) throw new Error("RAFA local control is not configured.");
  const response = await fetch(`http://127.0.0.1:${port}/reply-edit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rafa-local-control-token": token
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `RAFA local worker failed: ${response.status}`);
  if (!body.result || body.result.status !== "sent") throw new Error("RAFA local worker did not confirm delivery.");
  return body.result;
}

function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "Command failed.").trim()));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function conversationStats(users, now) {
  const ranges = {
    today: startOfDay(now),
    week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    month: new Date(now.getFullYear(), now.getMonth(), 1)
  };
  const result = {
    conversationsToday: 0,
    conversationsThisWeek: 0,
    conversationsThisMonth: 0,
    messagesToday: 0
  };

  for (const user of users) {
    const history = user.history || [];
    if (history.some((item) => dateValue(item.at) >= ranges.today)) result.conversationsToday += 1;
    if (history.some((item) => dateValue(item.at) >= ranges.week)) result.conversationsThisWeek += 1;
    if (history.some((item) => dateValue(item.at) >= ranges.month)) result.conversationsThisMonth += 1;
    result.messagesToday += history.filter((item) => dateValue(item.at) >= ranges.today).length;
  }

  return result;
}

function botStatus(events) {
  const relevant = events.filter((event) => ["ready", "connection_close", "startup_error"].includes(event.event));
  const latest = relevant[relevant.length - 1] || null;
  const latestActivity = events[events.length - 1] || null;
  return {
    connected: latest?.event === "ready",
    lastState: latest?.event || "unknown",
    lastSeen: latestActivity?.at || latest?.at || null,
    lastConnectionEvent: latest?.at || null
  };
}

function countEventsToday(events, eventName, now) {
  const today = startOfDay(now);
  return events.filter((event) => event.event === eventName && dateValue(event.at) >= today).length;
}

function usageEstimate(events, users, now) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const aiRequests = events.filter((event) => event.event === "ai" && dateValue(event.at) >= monthStart).length;
  const model = resolveOpenRouterModel(process.env.OPENROUTER_MODEL);
  const estimatedTokensPerRequest = Number(process.env.OPENROUTER_ESTIMATED_TOKENS_PER_REQUEST || 1000);
  const costPer1k = Number(process.env.OPENROUTER_ESTIMATED_COST_PER_1K || (model.endsWith(":free") ? 0 : 0.001));
  const estimatedTokens = aiRequests * estimatedTokensPerRequest;
  const estimatedCost = (estimatedTokens / 1000) * costPer1k;
  const totalMessagesThisMonth = users.reduce((count, user) => {
    return count + (user.history || []).filter((item) => dateValue(item.at) >= monthStart).length;
  }, 0);

  return {
    model,
    aiRequests,
    totalMessagesThisMonth,
    estimatedTokens,
    estimatedCost,
    costPer1k,
    estimatedTokensPerRequest
  };
}

function reportHistory(events) {
  return events
    .filter((event) => event.event === "report_generated" || event.event === "monthly_report_sent")
    .slice(-5)
    .reverse()
    .map((event) => ({
      name: `Conversation export · ${event.reportDate || String(event.at).slice(0, 10)}`,
      modifiedAt: event.at,
      userCount: Number(event.userCount || 0),
      rowCount: Number(event.rowCount || 0)
    }));
}

async function cleanupTempReport(directory) {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

function userSummary(user, { includeHandoverSummary = false } = {}) {
  const history = user.history || [];
  const last = history.reduce((latest, item) => dateValue(item.at) > dateValue(latest?.at) ? item : latest, null) || {};
  const rawContactId = user.id || user.phone;
  const workflow = operatorSignals(user);
  if (!includeHandoverSummary) workflow.handover = { ...workflow.handover, summary: "" };
  return {
    id: user.id,
    phone: displayPhone(user),
    name: displayName(user),
    rawPhone: isWhatsAppLid(rawContactId) ? "" : formatWhatsAppNumber(rawContactId),
    nameOverride: user.profile?.nameOverride || "",
    phoneOverride: user.profile?.phoneOverride || "",
    whatsappName: user.whatsapp?.pushName || user.profile?.whatsappName || "",
    company: user.profile?.company || "",
    need: user.profile?.needOverride || user.profile?.need || "",
    qualificationStatus: normalizeQualificationStatus(user.profile?.qualification?.status),
    qualificationReviewedAt: user.profile?.qualification?.reviewedAt || null,
    leadTemperatureStatus: user.profile?.leadTemperature?.status || "unclassified",
    leadTemperatureReason: user.profile?.leadTemperature?.reason || "no_clear_signal",
    leadTemperatureUpdatedAt: user.profile?.leadTemperature?.updatedAt || null,
    workflow,
    // Compatibility aliases keep the existing dashboard seams useful to older clients.
    intent: workflow.intent,
    classification: workflow.classification,
    priority: workflow.priority,
    isComplaint: workflow.flags.complaint,
    existingClient: workflow.flags.existingClient,
    handoverRequired: workflow.handover.required,
    followUpConsent: workflow.consent.followUp,
    bookingStatus: user.booking?.status || "none",
    conversationCount: history.length,
    lastMessageAt: last.at || "",
    lastMessagePreview: String(last.message || last.response || "").slice(0, 160)
  };
}

function conversationReplyTurn(turn) {
  return {
    id: turn.id,
    role: "assistant",
    direction: "outgoing",
    content: String(turn.response || ""),
    at: turn.at,
    source: turn.source || "whatsapp",
    delivery: turn.metadata?.delivery || null,
    editability: { canEditOnWhatsApp: false, canSendCorrection: true, canSaveLocally: true }
  };
}

function performanceClientLabel(userId, usersById, isAdmin, source = "whatsapp") {
  if (source === "dashboard") return "Dashboard chat";
  const user = usersById.get(userId);
  if (isAdmin && user) {
    const name = displayName(user);
    const digits = displayPhone(user).replace(/\D/g, "");
    const maskedPhone = digits ? `••${digits.slice(-4)}` : "";
    return name && maskedPhone ? `${name} · ${maskedPhone}` : name || maskedPhone || "RAFA contact";
  }
  if (!userId) return "Unlinked interaction";
  const pseudonymKey = process.env.RAFA_DASHBOARD_SUPABASE_SECRET || process.env.RAFA_API_SECRET || process.env.SUPABASE_URL || "rafa-performance";
  const pseudonym = crypto.createHmac("sha256", pseudonymKey).update(String(userId)).digest("hex").slice(0, 6).toUpperCase();
  return `Lead ${pseudonym}`;
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function logOpenRouterUsage(source, userId, usage) {
  const { event, fields } = buildModelUsageEvent(source, userId, usage);
  return store.logEvent(event, fields).catch((error) => {
    console.error("OpenRouter usage log failed:", error.message);
  });
}

function displayPhone(user) {
  const override = String(user.profile?.phoneOverride || user.phoneOverride || user.contact?.phone || "").trim();
  if (override) return override;
  const whatsappPhoneJid = String(user.whatsapp?.phoneJid || "").trim();
  if (/^\d{5,20}(?::\d{1,3})?@(?:s\.whatsapp\.net|c\.us)$/.test(whatsappPhoneJid)) return formatWhatsAppNumber(whatsappPhoneJid);
  if (isWhatsAppLid(user.id || user.phone)) return "Number hidden by WhatsApp";
  return formatWhatsAppNumber(user.id || user.phone);
}

function formatWhatsAppNumber(value) {
  const original = String(value || "").replace(/^self-test:/, "");
  const raw = original
    .replace(/@.+$/, "")
    .replace(/\D/g, "");

  if (!raw) return "";
  if (original.includes("@lid")) return `WhatsApp LID ${raw}`;
  if (raw.startsWith("357") && raw.length === 11) return `+${raw}`;
  if (raw.length === 8 && /^[29]/.test(raw)) return `+357 ${raw}`;
  if (raw.startsWith("00")) return `+${raw.slice(2)}`;
  return `+${raw}`;
}

function isWhatsAppLid(value) {
  return String(value || "").replace(/^self-test:/, "").includes("@lid");
}

async function listAgentSessions(ownerUserId = null, includeUnowned = false) {
  const owner = encodeURIComponent(ownerUserId || "");
  const ownership = ownerUserId
    ? includeUnowned
      ? `&or=(owner_user_id.eq.${owner},owner_user_id.is.null)`
      : `&owner_user_id=eq.${owner}`
    : "&owner_user_id=is.null";
  const sessions = await supabaseRest(`rafa_agent_sessions?select=id,title,model,memory_enabled,owner_user_id,created_at,updated_at${ownership}&order=updated_at.desc&limit=40`);
  return sessions.map(normalizeAgentSession);
}

async function createAgentSession(body = {}, ownerUserId = null, canConfigure = false) {
  const rows = await supabaseRest("rafa_agent_sessions?select=id,title,model,memory_enabled,owner_user_id,created_at,updated_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      title: cleanTitle(body.title || "New chat"),
      model: resolveOpenRouterModel(canConfigure && body.model || process.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL),
      memory_enabled: body.memoryEnabled !== false,
      owner_user_id: ownerUserId
    })
  });
  return normalizeAgentSession(rows[0]);
}

async function updateAgentSession(sessionId, body = {}) {
  const patch = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) patch.title = cleanTitle(body.title || "New chat");
  if (body.model !== undefined) patch.model = resolveOpenRouterModel(body.model);
  if (body.memoryEnabled !== undefined) patch.memory_enabled = body.memoryEnabled !== false;
  const rows = await supabaseRest(`rafa_agent_sessions?id=eq.${encodeURIComponent(sessionId)}&select=id,title,model,memory_enabled,owner_user_id,created_at,updated_at`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  return normalizeAgentSession(rows[0] || null);
}

async function getAgentSession(sessionId, dashboardUser = null) {
  const sessions = await supabaseRest(`rafa_agent_sessions?id=eq.${encodeURIComponent(sessionId)}&select=id,title,model,memory_enabled,owner_user_id,created_at,updated_at&limit=1`);
  const session = normalizeAgentSession(sessions[0] || null);
  if (!session || (dashboardUser && !canAccessDashboardSession(session, dashboardUser))) return { session: null, messages: [] };
  const messages = await supabaseRest(`rafa_agent_messages?session_id=eq.${encodeURIComponent(sessionId)}&select=id,session_id,role,content,metadata,created_at&order=created_at.asc`);
  return { session, messages };
}

function normalizeAgentSession(session) {
  if (!session) return null;
  return { ...session, model: resolveOpenRouterModel(session.model, DEFAULT_OPENROUTER_MODEL) };
}

async function addAgentMessage(sessionId, body) {
  const rows = await supabaseRest("rafa_agent_messages?select=id,session_id,role,content,metadata,created_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      session_id: sessionId,
      role: body.role,
      content: body.content,
      metadata: body.metadata || {}
    })
  });
  await supabaseRest(`rafa_agent_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ updated_at: new Date().toISOString() })
  });
  return rows[0];
}

async function listAgentMemories() {
  return supabaseRest("rafa_agent_memories?select=id,label,content,source_session_id,pinned,created_at,updated_at&order=pinned.desc,created_at.desc&limit=80");
}

async function createAgentMemory(body = {}) {
  const content = String(body.content || "").trim();
  if (!content) throw new Error("Memory content is required.");
  const rows = await supabaseRest("rafa_agent_memories?select=id,label,content,source_session_id,pinned,created_at,updated_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      label: cleanTitle(body.label || "Memory"),
      content,
      source_session_id: body.sourceSessionId || null,
      pinned: Boolean(body.pinned)
    })
  });
  return rows[0];
}

async function supabaseRest(pathname, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const secret = process.env.RAFA_DASHBOARD_SUPABASE_SECRET;
  if (!url || !key || !secret) {
    throw new Error("Missing Supabase dashboard REST configuration.");
  }

  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-rafa-dashboard-secret": secret,
      ...(options.headers || {})
    }
  });
  if (response.status === 204) return [];
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `Supabase REST failed: ${response.status}`);
    // Additive diagnostics. The Postgres / PostgREST error code is the only
    // reliable way to tell "this migration has not been applied" (42P01,
    // PGRST205) apart from a genuine failure — see factRegisterView.js. `code`
    // is deliberately left alone: every existing caller reads it as an HTTP
    // status (`res.status(error.code || 500)`).
    error.pgCode = body.code || "";
    error.pgHint = body.hint || "";
    error.pgDetails = body.details || "";
    error.httpStatus = response.status;
    throw error;
  }
  return body;
}

async function assertSpecialistFollowUpConsent(contactId) {
  const consents = await supabaseRest(`rafa_contact_consents?contact_id=eq.${encodeURIComponent(contactId)}&consent_type=eq.follow_up&select=state,source_turn_id&limit=1`);
  const consent = consents[0];
  if (consent?.state !== "granted" || !consent.source_turn_id) throw followUpConsentRequired();
  const turns = await supabaseRest(`rafa_conversation_turns?id=eq.${encodeURIComponent(consent.source_turn_id)}&select=id,metadata&limit=1`);
  if (!hasPurposeBoundFollowUpConsent(consent, turns[0])) throw followUpConsentRequired();
}

function followUpConsentRequired() {
  const error = new Error("Specialist follow-up consent is required.");
  error.statusCode = 403;
  return error;
}

async function dashboardKnowledge(text) {
  try {
    const embedding = await embedText(text);
    return await supabaseRest("rpc/rafa_hybrid_search_knowledge", { method: "POST", body: JSON.stringify({ p_query: text, p_embedding: `[${embedding.join(",")}]`, p_embedding_model: DEFAULT_EMBEDDING_MODEL, p_match_count: 5 }) });
  } catch {
    return supabaseRest("rpc/rafa_search_knowledge", { method: "POST", body: JSON.stringify({ p_query: text, p_match_count: 5 }) }).catch(() => []);
  }
}

async function relevantAgentMemories(text) {
  try {
    return await supabaseRest("rpc/rafa_search_agent_memories", {
      method: "POST",
      body: JSON.stringify({ p_query: text, p_match_count: 5 })
    });
  } catch {
    return (await listAgentMemories()).filter((memory) => memory.pinned).slice(0, 5);
  }
}

async function askDashboardAgent({ text, messages, model: sessionModel, memories, evidence, signal, onToken, onUsage }) {
  // Evidence is only authoritative after the Edge generation endpoint reloads
  // its canonical chunks and fact-register rows. Do not fall back to a local
  // model that would receive the raw dashboard search results.
  const model = resolveOpenRouterModel(sessionModel || process.env.OPENROUTER_MODEL).slice(0, 160);
  return askSupabaseAgent({ text, messages, model, memories, evidence, signal, onToken, onUsage });
}
async function askSupabaseAgent({ text, messages, model, memories, evidence, signal, onToken, onUsage }) {
  const apiUrl = process.env.RAFA_API_URL || `${String(process.env.SUPABASE_URL || "").replace(/\/$/, "")}/functions/v1/rafa-agent-api`;
  const apiSecret = process.env.RAFA_API_SECRET;
  if (!apiUrl || !apiSecret) throw new Error("RAFA Supabase agent API is not configured.");
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/agent/generate`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-rafa-api-secret": apiSecret
    },
    body: JSON.stringify({ text, messages, model, memories, evidence })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `RAFA agent API failed: ${response.status}`);
  const reply = String(body.reply || "").trim();
  if (!reply) throw new Error("RAFA agent API returned an empty reply.");
  onToken(reply);
  if (body.usage) await onUsage?.(body.usage);
  return reply;
}


function extractMemory(text) {
  const match = String(text || "").match(/\b(?:remember|save this|memorize)\b(?: that| this|:)?\s+(.{8,500})/i);
  if (!match) return null;
  const content = match[1].trim();
  return {
    label: titleFromMessage(content),
    content
  };
}

function titleFromMessage(text) {
  return cleanTitle(String(text || "New chat").replace(/\s+/g, " ").slice(0, 56));
}

function cleanTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 80) : "New chat";
}

async function resolveDashboardIdentity(req, res) {
  const client = createRequestAuthClient(req, res);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return { client, user: null, account: null };
  return { client, user: data.user, account: await dashboardAccount(data.user.id) };
}

async function dashboardAccount(userId) {
  const id = requireUuid(userId);
  const rows = await supabaseRest(`rafa_dashboard_users?user_id=eq.${id}&select=user_id,role,is_active&limit=1`);
  return rows[0] || null;
}

function publicUser(user, account) {
  return { id: user.id, email: user.email || "", role: account?.role || "pending", isActive: account?.is_active ?? true };
}

async function requireSignedIn(req, res, next) {
  try {
    const identity = await resolveDashboardIdentity(req, res);
    if (!identity.user) {
      clearAuthCookies(req, res, Boolean(req.secure));
      return res.status(401).json({ error: "Sign in to continue." });
    }
    if (identity.account && !identity.account.is_active) return res.status(403).json({ error: "This account is disabled." });
    req.authClient = identity.client;
    req.dashboardUser = publicUser(identity.user, identity.account);
    return next();
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : "Could not verify your dashboard session." });
  }
}

function requireAuth(req, res, next) {
  return requireSignedIn(req, res, () => {
    if (!roleAllows(req.dashboardUser.role, "user")) return res.status(403).json({ error: "This account is not authorized for the dashboard." });
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.dashboardUser?.role !== "admin") return res.status(403).json({ error: "Administrator access is required." });
  next();
}

async function invokeAdminFunction(client, body) {
  const { data, error } = await client.functions.invoke("rafa-admin-api", { body });
  if (!error) return data;
  let detail;
  try { detail = await error.context?.json(); } catch { /* Use the SDK message when no JSON body exists. */ }
  const statusCode = error.context?.status || 502;
  const failure = new Error(detail?.error || "Could not complete this account operation.");
  failure.statusCode = statusCode;
  throw failure;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function authRateLimit(req, res, next) {
  const now = Date.now();
  const key = `${req.ip}:${req.path}`;
  const entry = authAttemptBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    authAttemptBuckets.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    if (authAttemptBuckets.size > 5000) {
      for (const [bucket, value] of authAttemptBuckets) if (value.resetAt <= now) authAttemptBuckets.delete(bucket);
    }
    return next();
  }
  if (entry.count >= (req.path.includes("forgot-password") ? 4 : 12)) {
    res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
    return res.status(429).json({ error: "Too many authentication attempts. Wait a few minutes and try again." });
  }
  entry.count += 1;
  return next();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}
