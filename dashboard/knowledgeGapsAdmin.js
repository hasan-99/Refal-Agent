// Knowledge Gaps: dashboard API.
//
// Reads go to any signed-in dashboard user (the app-wide requireAuth already
// runs before these routes); every state change requires an administrator and
// goes through an audited RPC (supabase/migrations/20261028130000_rafa_knowledge_gaps.sql).
// The section is hidden and these routes answer 404 when the feature is off.
//
// Knowledge is never written here. "Create Knowledge From Gap" returns a
// prefill for the existing knowledge editor; saving it uses the existing
// pending-review path, and approval stays an explicit administrator decision.

import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  GAP_PRIORITIES, GAP_REASON_LABELS, GAP_STATUSES, GAP_STATUS_LABELS, KNOWLEDGE_GAP_CODES, buildKnowledgeDraftPrefill,
  computeGapPriority, gapFingerprint, planGapAction, redactGapText
} from "../supabase/functions/rafa-agent-api/knowledgeGapPolicy.mjs";

const require = createRequire(import.meta.url);
const { verifyGapResolution, createGapSearch } = require("../src/knowledgeGapRegression.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MISSING_OBJECT_CODES = new Set(["42P01", "42883", "PGRST202", "PGRST205"]);
const GROUP_COLUMNS = "id,title,summary,category,intent,reason,reason_locked,reason_counts,status,priority_override,owner,occurrence_count,suppressed_count,no_safe_answer_count,languages,example_questions,sensitive_topics,blocking,analytics_only,resolution,resolved_at,resolved_by,verified_at,first_seen_at,last_seen_at,updated_at";
const EVENT_COLUMNS = "id,occurred_at,contact_id,question_redacted,search_query_redacted,language,intent,category,outcome,reason_code,reason,suspected_reason,confidence,search_ran,search_queries,top_chunks,candidate_ids,candidate_count,rerank,grounding_rejected,rejection_reasons,response_type,no_safe_answer,model,prompt_version,agent_version,signals";

export function knowledgeGapsDashboardEnabled(env = process.env) {
  const explicit = String(env?.RAFA_KNOWLEDGE_GAPS_DASHBOARD ?? "").trim();
  const value = explicit || String(env?.RAFA_KNOWLEDGE_GAPS ?? "").trim();
  return /^(?:on|true|1|yes)$/iu.test(value);
}

function httpError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function sendError(res, error) {
  if (MISSING_OBJECT_CODES.has(error?.pgCode)) {
    return res.status(503).json({ error: "The Knowledge Gaps migration has not been applied in this environment.", migrationApplied: false });
  }
  const status = Number.isInteger(error?.code) && error.code >= 400 && error.code < 600 ? error.code : 502;
  return res.status(status).json({ error: status >= 500 ? "Knowledge gaps request failed." : error.message, ...(error.payload || {}) });
}

function requireUuid(value) {
  const id = String(value || "");
  if (!UUID.test(id)) throw httpError(400, "Invalid knowledge gap id.");
  return id;
}

function actorOf(req) {
  return String(req.dashboardUser?.email || req.dashboardUser?.id || "").trim().slice(0, 320);
}

function cleanReason(value) {
  return redactGapText(String(value ?? ""), 500);
}

// Stable anonymous label for a conversation: never the contact id itself.
export function anonymousConversationLabel(contactId) {
  if (!contactId) return "Unknown conversation";
  return `Conversation ${crypto.createHash("sha256").update(`rafa-gap:${contactId}`).digest("hex").slice(0, 6)}`;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) if (value !== null && value !== undefined && value !== "") counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([key, count]) => ({ key, count }));
}

export function withPriority(group, stats = {}) {
  const priority = computeGapPriority({
    override: group.priority_override, count: group.occurrence_count, last7Days: stats.last_7_days, previous7Days: stats.previous_7_days,
    distinctContacts: stats.distinct_contacts, noSafeAnswerCount: group.no_safe_answer_count, sensitiveTopics: group.sensitive_topics,
    blocking: group.blocking, reason: group.reason, analyticsOnly: group.analytics_only
  });
  return { ...group, priority: priority.priority, priorityScore: priority.score, priorityFactors: priority.factors, priorityOverridden: priority.overridden,
    last7Days: stats.last_7_days || 0, previous7Days: stats.previous_7_days || 0, distinctContacts: stats.distinct_contacts || 0,
    statusLabel: GAP_STATUS_LABELS[group.status] || group.status, reasonLabel: GAP_REASON_LABELS[group.reason] || group.reason };
}

const OPEN_STATUSES = new Set(["open", "reviewing", "needs_knowledge", "needs_retrieval_fix", "needs_agent_fix"]);
const DONE_STATUSES = new Set(["resolved", "verified"]);

export function filterGapGroups(groups, query = {}, linksByGroup = new Map()) {
  const text = String(query.q || "").normalize("NFKC").toLocaleLowerCase().trim().slice(0, 200);
  const from = Date.parse(query.from || "");
  const to = Date.parse(query.to || "");
  const pick = (value) => String(value || "").trim();
  return groups.filter((group) => {
    const status = pick(query.status);
    if (status && status !== "all" && (status === "active" ? !OPEN_STATUSES.has(group.status)
      : status === "done" ? !DONE_STATUSES.has(group.status) : group.status !== status)) return false;
    if (pick(query.category) && pick(query.category) !== "all" && group.category !== pick(query.category)) return false;
    if (pick(query.priority) && pick(query.priority) !== "all" && group.priority !== pick(query.priority)) return false;
    if (pick(query.reason) && pick(query.reason) !== "all" && group.reason !== pick(query.reason)) return false;
    if (pick(query.language) && pick(query.language) !== "all" && !(group.languages || []).includes(pick(query.language))) return false;
    if (pick(query.intent) && pick(query.intent) !== "all" && group.intent !== pick(query.intent)) return false;
    if (pick(query.owner) && pick(query.owner) !== "all" && (pick(query.owner) === "unassigned" ? Boolean(group.owner) : group.owner !== pick(query.owner))) return false;
    if (Number.isFinite(from) && Date.parse(group.last_seen_at) < from) return false;
    if (Number.isFinite(to) && Date.parse(group.first_seen_at) > to + 86400000 - 1) return false;
    if (!text) return true;
    const haystack = [group.title, group.summary, ...(group.example_questions || []).map((item) => item?.question),
      ...(linksByGroup.get(group.id) || []).flatMap((link) => [link.label, link.chunk_id, link.document_id])]
      .map((value) => String(value || "").normalize("NFKC").toLocaleLowerCase());
    return haystack.some((value) => value.includes(text));
  });
}

export function gapMetrics(groups, recentEvents = [], now = new Date()) {
  const nowMs = now.getTime();
  const weekAgo = nowMs - 7 * 86400000;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const open = groups.filter((group) => OPEN_STATUSES.has(group.status));
  const knowledgeOpen = open.filter((group) => !group.analytics_only);
  const days = [];
  for (let index = 13; index >= 0; index -= 1) {
    const day = new Date(nowMs - index * 86400000).toISOString().slice(0, 10);
    days.push({ day, count: recentEvents.filter((event) => String(event.occurred_at || "").slice(0, 10) === day).length });
  }
  return {
    openGaps: knowledgeOpen.length,
    newThisWeek: groups.filter((group) => Date.parse(group.first_seen_at) >= weekAgo).length,
    questionsAffected: knowledgeOpen.reduce((sum, group) => sum + (Number(group.occurrence_count) || 0), 0),
    highPriority: knowledgeOpen.filter((group) => ["critical", "high"].includes(group.priority)).length,
    resolvedThisMonth: groups.filter((group) => ["resolved", "verified"].includes(group.status) && Date.parse(group.resolved_at) >= monthStart).length,
    missingKnowledge: knowledgeOpen.filter((group) => group.reason === "missing_knowledge" || group.reason === "expired_knowledge").length,
    retrievalFailures: knowledgeOpen.filter((group) => group.reason === "weak_retrieval").length,
    agentIssues: knowledgeOpen.filter((group) => group.reason === "agent_failure").length,
    systemFailures: open.filter((group) => group.reason === "system_failure").length,
    topLanguages: countBy(knowledgeOpen.flatMap((group) => group.languages || [])).slice(0, 5),
    topCategories: countBy(knowledgeOpen.map((group) => group.category)).slice(0, 5),
    trend: days
  };
}

// Turns the raw events of one gap into the evidence an administrator needs to
// tell missing knowledge, weak retrieval, a chunk that needs improvement and
// an agent logic issue apart. Deterministic; documented per hint below.
export function gapDiagnostics(events = [], links = []) {
  const total = events.length;
  const chunkStats = new Map();
  for (const event of events) {
    for (const chunk of Array.isArray(event.top_chunks) ? event.top_chunks : []) {
      if (!chunk?.id) continue;
      const entry = chunkStats.get(chunk.id) || { id: chunk.id, seen: 0, bestRank: null, relevance: [], validUntil: chunk.validUntil || null };
      entry.seen += 1;
      if (Number.isInteger(chunk.rank)) entry.bestRank = entry.bestRank === null ? chunk.rank : Math.min(entry.bestRank, chunk.rank);
      if (Number.isFinite(chunk.relevance)) entry.relevance.push(chunk.relevance);
      chunkStats.set(chunk.id, entry);
    }
  }
  const topChunks = [...chunkStats.values()].map((entry) => ({ id: entry.id, seen: entry.seen, bestRank: entry.bestRank, validUntil: entry.validUntil,
    meanRelevance: entry.relevance.length ? Number((entry.relevance.reduce((s, v) => s + v, 0) / entry.relevance.length).toFixed(3)) : null }))
    .sort((a, b) => b.seen - a.seen || (a.bestRank ?? 99) - (b.bestRank ?? 99)).slice(0, 10);
  const rejection = countBy(events.flatMap((event) => event.rejection_reasons || []));
  const searchRan = events.filter((event) => event.search_ran).length;
  const withEvidence = events.filter((event) => Array.isArray(event.top_chunks) && event.top_chunks.length > 0).length;
  const linked = links.filter((link) => link.chunk_id).map((link) => {
    const inTop = events.filter((event) => (event.top_chunks || []).some((chunk) => chunk?.id === link.chunk_id)).length;
    const inCandidates = events.filter((event) => (event.candidate_ids || []).includes(link.chunk_id)).length;
    return { chunkId: link.chunk_id, label: link.label, linkType: link.link_type, retrievedInTop: inTop, retrievedAsCandidate: inCandidates, events: total };
  });
  const systemShare = total ? events.filter((event) => event.reason === "system_failure").length / total : 0;
  const knowledgeCodes = rejection.filter((item) => KNOWLEDGE_GAP_CODES.has(item.key)).reduce((s, item) => s + item.count, 0);
  const behaviourCodes = rejection.filter((item) => !KNOWLEDGE_GAP_CODES.has(item.key)).reduce((s, item) => s + item.count, 0);
  let hint;
  if (total === 0) hint = { code: "no_events", label: "No events", explanation: "No recorded questions yet." };
  else if (systemShare >= 0.5) hint = { code: "system", label: "System failure", explanation: "Most turns failed technically (prompt ceiling, provider or retrieval error). Fix the system first; knowledge may be fine." };
  else if (searchRan / total < 0.5) hint = { code: "agent_logic", label: "Agent logic issue", explanation: "The agent did not search approved knowledge in most of these turns." };
  else if (linked.some((item) => item.retrievedInTop > 0)) {
    hint = behaviourCodes > knowledgeCodes
      ? { code: "agent_logic", label: "Agent logic issue", explanation: "The linked knowledge was retrieved, but drafts were rejected for behaviour reasons (context, language, format)." }
      : { code: "chunk_needs_improvement", label: "Chunk needs improvement", explanation: "The linked knowledge was retrieved but did not support the answer. Improve the entry so it states the fact asked about." };
  } else if (linked.some((item) => item.retrievedAsCandidate > 0)) hint = { code: "weak_retrieval", label: "Weak retrieval (ranked too low)", explanation: "The linked knowledge appeared as a candidate but never reached the evidence the agent saw." };
  else if (linked.length > 0) hint = { code: "weak_retrieval", label: "Weak retrieval (not retrieved)", explanation: "Knowledge exists and is linked, but search never returned it for these questions." };
  else if (withEvidence === 0) hint = { code: "missing_knowledge", label: "Missing knowledge", explanation: "Approved search ran and returned nothing relevant for any of these questions." };
  else if (knowledgeCodes > 0 && behaviourCodes <= knowledgeCodes) hint = { code: "partial_knowledge", label: "Partial knowledge or weak retrieval", explanation: "Search returned some knowledge, but specific claims were unsupported. Link the right entry if it exists, otherwise add the missing fact." };
  else hint = { code: "agent_logic", label: "Agent logic issue", explanation: "Evidence was available; rejections were about behaviour, not missing facts." };
  return {
    events: total,
    searchRanShare: total ? Number((searchRan / total).toFixed(2)) : 0,
    evidenceShare: total ? Number((withEvidence / total).toFixed(2)) : 0,
    queries: countBy(events.flatMap((event) => event.search_queries || [])).slice(0, 10),
    topChunks,
    expectedKnowledge: linked,
    rerank: countBy(events.map((event) => (event.rerank?.ran ? event.rerank.status || "ran" : "not_run"))),
    grounding: { rejectedShare: total ? Number((events.filter((event) => event.grounding_rejected).length / total).toFixed(2)) : 0, reasons: rejection },
    agent: { models: countBy(events.map((event) => event.model)), responseTypes: countBy(events.map((event) => event.response_type)),
      outcomes: countBy(events.map((event) => event.outcome)), promptVersions: countBy(events.map((event) => event.prompt_version)) },
    reasons: countBy(events.map((event) => event.reason)),
    hint
  };
}

function shapeEvent(event) {
  return {
    id: event.id, at: event.occurred_at, conversation: anonymousConversationLabel(event.contact_id), question: event.question_redacted,
    searchQuery: event.search_query_redacted, language: event.language, outcome: event.outcome, reason: event.reason,
    reasonLabel: GAP_REASON_LABELS[event.reason] || event.reason, confidence: event.confidence, responseType: event.response_type,
    rejectionReasons: event.rejection_reasons || [], topChunks: event.top_chunks || [], model: event.model, reasonCode: event.reason_code
  };
}

function regressionTestsFor(group, links, { minRank = 5 } = {}) {
  const questions = [...new Map([group.title, ...(group.example_questions || []).map((item) => item?.question)]
    .map((value) => redactGapText(value, 500)).filter(Boolean).map((value) => [gapFingerprint(value), value])).entries()].slice(0, 6);
  const language = (value) => (/[؀-ۿ]/u.test(value) ? "ar" : /[Ͱ-Ͽ]/u.test(value) ? "el" : "en");
  return questions.map(([fingerprint, query]) => ({
    query, query_fingerprint: fingerprint, language: language(query),
    expected_chunk_ids: links.map((link) => link.chunk_id).filter(Boolean),
    expected_document_ids: links.map((link) => link.document_id).filter(Boolean),
    expected_source_ids: links.map((link) => link.source_id).filter(Boolean),
    expected_min_rank: minRank, expected_behavior: "grounded_answer"
  }));
}

export function registerKnowledgeGapAdminRoutes(app, {
  requireAdmin, supabaseRest, readAllRows = (path) => supabaseRest(path), env = process.env, now = () => new Date(),
  createVerifier = null, logEvent = async () => {}, getSettings = null, updateSettings = null
} = {}) {
  if (!app?.get || !app?.post || typeof requireAdmin !== "function" || typeof supabaseRest !== "function") {
    throw new TypeError("An Express app, requireAdmin and supabaseRest are required.");
  }
  const enabled = () => knowledgeGapsDashboardEnabled(env);
  const gate = (_req, res, next) => (enabled() ? next() : res.status(404).json({ error: "Knowledge gaps are not enabled." }));
  const rpc = (name, body) => supabaseRest(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });

  async function loadGroup(id) {
    const rows = await supabaseRest(`rafa_knowledge_gap_groups?id=eq.${id}&select=${GROUP_COLUMNS}&limit=1`);
    if (!rows?.[0]) throw httpError(404, "Knowledge gap not found.");
    return rows[0];
  }

  async function runVerification(group, actor, { newStatusOnPass = null, reason = "" } = {}) {
    const tests = await supabaseRest(`rafa_knowledge_gap_regression_tests?group_id=eq.${group.id}&active=eq.true&select=*`);
    if (!tests.length) return { ran: 0, passed: false, retrievalPassed: false, results: [], agent: { status: "not_run" }, noTests: true };
    if (typeof createVerifier !== "function") throw httpError(503, "Retrieval verification is not configured on this dashboard.");
    const { search, agentVerifier } = await createVerifier();
    const verification = await verifyGapResolution(tests, { search, agentVerifier });
    const recorded = await rpc("rafa_record_knowledge_gap_verification", {
      p_group_id: group.id, p_expected_status: group.status,
      p_results: verification.results.map(({ id, result, rank, details }) => ({ id, result, rank, details: { ...details, agent: verification.agent.status } })),
      p_actor: actor, p_reason: reason || (verification.passed ? "Retrieval verification passed." : "Retrieval verification failed."),
      p_new_status: verification.passed ? newStatusOnPass : null
    });
    return { ...verification, recorded };
  }

  app.get("/api/knowledge-gaps/config", (req, res) => {
    res.json({ enabled: enabled(), canManage: req.dashboardUser?.role === "admin", statuses: GAP_STATUSES.map((id) => ({ id, label: GAP_STATUS_LABELS[id] })),
      priorities: GAP_PRIORITIES, reasons: Object.entries(GAP_REASON_LABELS).map(([id, label]) => ({ id, label })) });
  });

  // Admin recording switch. Stored centrally (rafa_settings via the Edge API) so
  // the WhatsApp worker picks it up within ~30 s without a restart. The worker's
  // own RAFA_KNOWLEDGE_GAPS flag stays the master switch.
  app.get("/api/knowledge-gaps/settings", gate, async (req, res) => {
    try {
      if (typeof getSettings !== "function") throw httpError(503, "Knowledge gap settings are not available on this dashboard.");
      const value = await getSettings();
      res.json({ recording: value?.settings?.recording === true, updatedAt: value?.updatedAt || null, updatedBy: value?.updatedBy || null,
        canManage: req.dashboardUser?.role === "admin" });
    } catch (error) { sendError(res, error); }
  });

  app.put("/api/knowledge-gaps/settings", gate, requireAdmin, async (req, res) => {
    try {
      if (typeof updateSettings !== "function") throw httpError(503, "Knowledge gap settings are not available on this dashboard.");
      const actor = actorOf(req);
      if (!actor) throw httpError(403, "A named administrator is required.");
      if (typeof req.body?.recording !== "boolean") throw httpError(400, "recording must be true or false.");
      const value = await updateSettings({ recording: req.body.recording }, { updatedBy: actor });
      await logEvent("knowledge_gaps_recording_changed", { recording: req.body.recording, actor });
      res.json({ recording: value?.settings?.recording === true, updatedAt: value?.updatedAt || null, updatedBy: value?.updatedBy || actor, canManage: true });
    } catch (error) { sendError(res, error); }
  });

  app.get("/api/knowledge-gaps", gate, async (req, res) => {
    try {
      const since = new Date(now().getTime() - 14 * 86400000).toISOString();
      const [groups, stats, links, recent] = await Promise.all([
        readAllRows(`rafa_knowledge_gap_groups?select=${GROUP_COLUMNS}&order=last_seen_at.desc,id.desc`),
        readAllRows("rafa_knowledge_gap_group_stats?select=group_id,last_7_days,previous_7_days,distinct_contacts,no_safe_answer_events&order=group_id.asc"),
        readAllRows("rafa_knowledge_gap_links?select=group_id,chunk_id,document_id,label&order=created_at.asc,id.asc"),
        readAllRows(`rafa_knowledge_gap_events?select=occurred_at,group_id&occurred_at=gte.${encodeURIComponent(since)}&order=occurred_at.asc,id.asc`)
      ]);
      const statsByGroup = new Map(stats.map((row) => [row.group_id, row]));
      const linksByGroup = new Map();
      for (const link of links) linksByGroup.set(link.group_id, [...(linksByGroup.get(link.group_id) || []), link]);
      const prioritized = groups.map((group) => ({ ...withPriority(group, statsByGroup.get(group.id)), linkedCount: (linksByGroup.get(group.id) || []).length }));
      const filtered = filterGapGroups(prioritized, req.query || {}, linksByGroup);
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      filtered.sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));
      // Optional paging for the infinite list; without limit the full list is returned as before.
      const limit = Number.parseInt(req.query?.limit, 10);
      const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
      const paged = Number.isInteger(limit) && limit > 0 ? filtered.slice(offset, offset + Math.min(limit, 100)) : filtered;
      const nextOffset = paged === filtered || offset + paged.length >= filtered.length ? null : offset + paged.length;
      res.json({
        groups: paged.map(({ example_questions: examples, ...group }) => ({ ...group, exampleCount: (examples || []).length, examples: (examples || []).slice(-3) })),
        total: prioritized.length,
        filteredTotal: filtered.length,
        nextOffset,
        metrics: gapMetrics(prioritized, recent, now()),
        facets: {
          categories: countBy(prioritized.map((group) => group.category)).map((item) => item.key),
          intents: countBy(prioritized.map((group) => group.intent)).map((item) => item.key),
          owners: countBy(prioritized.map((group) => group.owner)).map((item) => item.key),
          languages: countBy(prioritized.flatMap((group) => group.languages || [])).map((item) => item.key)
        }
      });
    } catch (error) { sendError(res, error); }
  });

  app.get("/api/knowledge-gaps/regression-tests/export", gate, async (_req, res) => {
    try {
      const tests = await readAllRows("rafa_knowledge_gap_regression_tests?active=eq.true&select=id,group_id,query,language,expected_chunk_ids,expected_document_ids,expected_source_ids,expected_min_rank,expected_behavior,active,last_result,last_run_at&order=created_at.asc,id.asc");
      res.setHeader("Content-Disposition", "attachment; filename=\"knowledge-gap-regression-tests.json\"");
      res.json({ generatedAt: now().toISOString(), tests });
    } catch (error) { sendError(res, error); }
  });

  app.get("/api/knowledge-gaps/:id", gate, async (req, res) => {
    try {
      const id = requireUuid(req.params.id);
      const group = await loadGroup(id);
      const [stats, events, links, tests, audit] = await Promise.all([
        supabaseRest(`rafa_knowledge_gap_group_stats?group_id=eq.${id}&select=*`),
        supabaseRest(`rafa_knowledge_gap_events?group_id=eq.${id}&select=${EVENT_COLUMNS}&order=occurred_at.desc,id.desc&limit=100`),
        supabaseRest(`rafa_knowledge_gap_links?group_id=eq.${id}&select=id,chunk_id,document_id,source_id,link_type,weak_retrieval,label,linked_by,note,created_at&order=created_at.asc`),
        supabaseRest(`rafa_knowledge_gap_regression_tests?group_id=eq.${id}&select=id,query,language,expected_min_rank,expected_behavior,active,last_result,last_rank,last_run_at&order=created_at.asc`),
        supabaseRest(`rafa_knowledge_gap_audit?group_id=eq.${id}&select=id,action,actor,reason,previous_status,new_status,created_at&order=created_at.desc&limit=50`)
      ]);
      res.json({ group: withPriority(group, stats?.[0]), examples: events.slice(0, 25).map(shapeEvent), diagnostics: gapDiagnostics(events, links),
        links, regressionTests: tests, audit });
    } catch (error) { sendError(res, error); }
  });

  app.post("/api/knowledge-gaps/:id/actions", gate, requireAdmin, async (req, res) => {
    try {
      const id = requireUuid(req.params.id);
      const actor = actorOf(req);
      if (!actor) throw httpError(403, "A named administrator is required.");
      const action = String(req.body?.action || "");
      const reason = cleanReason(req.body?.reason);
      const group = await loadGroup(id);
      const markWeakRetrieval = req.body?.markWeakRetrieval === true;
      const plan = planGapAction(action, group.status, { markWeakRetrieval });
      if (!plan.ok) throw httpError(409, plan.error);
      if (plan.requiresReason && !reason) throw httpError(400, "Give a short reason for this action.");
      const patch = {};
      if (plan.status !== group.status) patch.status = plan.status;
      if (plan.reason) patch.reason = plan.reason;
      const apply = (details = {}, extraPatch = {}) => rpc("rafa_apply_knowledge_gap_action", {
        p_group_id: id, p_expected_status: group.status, p_action: action, p_actor: actor, p_reason: reason, p_patch: { ...patch, ...extraPatch }, p_details: details
      });

      if (action === "assign") {
        const owner = String(req.body?.owner ?? "").trim().slice(0, 320);
        return res.json({ result: await apply({ owner: owner || null }, { owner }) });
      }
      if (action === "set_priority") {
        const priority = String(req.body?.priority ?? "");
        if (priority && !GAP_PRIORITIES.includes(priority)) throw httpError(400, "Unknown priority.");
        return res.json({ result: await apply({ priority: priority || "automatic" }, { priority_override: priority }) });
      }
      if (action === "create_knowledge") {
        const examples = Array.isArray(group.example_questions) ? group.example_questions : [];
        const result = await apply({ prefill: "title_questions_category_only" });
        return res.json({ result, prefill: { ...buildKnowledgeDraftPrefill(group, examples), gapId: id } });
      }
      if (["link_existing", "improve_existing", "link_created"].includes(action)) {
        const minRank = Number.isInteger(req.body?.expectedMinRank) ? Math.min(16, Math.max(1, req.body.expectedMinRank)) : 5;
        let links;
        if (action === "link_existing") {
          const chunkIds = [...new Set((Array.isArray(req.body?.chunkIds) ? req.body.chunkIds : []).map(String).filter((value) => UUID.test(value)))].slice(0, 10);
          if (!chunkIds.length) throw httpError(400, "Choose at least one existing knowledge chunk.");
          const chunks = await supabaseRest(`rafa_knowledge_chunks?id=in.(${chunkIds.join(",")})&select=id,document_id,heading,rafa_knowledge_documents(source_id,title,review_status)`);
          if (chunks.length !== chunkIds.length) throw httpError(404, "One or more knowledge chunks were not found.");
          if (chunks.some((chunk) => chunk.rafa_knowledge_documents?.review_status !== "approved")) {
            throw httpError(409, "Only approved knowledge can be linked as existing knowledge.");
          }
          links = chunks.map((chunk) => ({ chunk_id: chunk.id, document_id: chunk.document_id, source_id: chunk.rafa_knowledge_documents?.source_id || null,
            link_type: "existing", weak_retrieval: markWeakRetrieval,
            label: String(chunk.rafa_knowledge_documents?.title || chunk.heading || "Knowledge entry").slice(0, 200) }));
        } else {
          const documentId = String(req.body?.documentId || "");
          if (!UUID.test(documentId)) throw httpError(400, "A knowledge document id is required.");
          const documents = await supabaseRest(`rafa_knowledge_documents?id=eq.${documentId}&select=id,source_id,title,review_status&limit=1`);
          if (!documents[0]) throw httpError(404, "Knowledge document not found.");
          if (!["approved", "pending"].includes(documents[0].review_status)) throw httpError(409, "Link an approved or pending knowledge entry.");
          links = [{ document_id: documents[0].id, source_id: documents[0].source_id, link_type: action === "link_created" ? "created" : "improved",
            weak_retrieval: false, label: String(documents[0].title || "Knowledge entry").slice(0, 200) }];
        }
        const result = await rpc("rafa_link_knowledge_gap", {
          p_group_id: id, p_expected_status: group.status, p_links: links, p_tests: regressionTestsFor(group, links, { minRank }),
          p_action: action, p_actor: actor, p_reason: reason || "Linked knowledge to gap.", p_patch: patch
        });
        return res.json({ result, ...(action === "improve_existing" ? { openDocumentId: links[0].document_id, openSourceId: links[0].source_id } : {}) });
      }
      if (action === "resolve") {
        const verification = await runVerification(group, actor, { newStatusOnPass: "verified", reason });
        if (verification.noTests) {
          const result = await apply({ verification: "not_applicable", note: "No linked knowledge; resolved without retrieval verification." });
          return res.json({ result, verification: { ran: 0, status: "not_applicable" } });
        }
        if (!verification.passed) {
          return res.status(409).json({ error: "Retrieval verification failed, so the gap stays open. See the results below.", verification });
        }
        return res.json({ result: verification.recorded, verification });
      }
      return res.json({ result: await apply() });
    } catch (error) { sendError(res, error); }
  });

  app.post("/api/knowledge-gaps/:id/verify", gate, requireAdmin, async (req, res) => {
    try {
      const id = requireUuid(req.params.id);
      const actor = actorOf(req);
      if (!actor) throw httpError(403, "A named administrator is required.");
      const group = await loadGroup(id);
      const verification = await runVerification(group, actor, { reason: "Manual verification run." });
      if (verification.noTests) throw httpError(409, "This gap has no regression tests yet. Link knowledge first.");
      await logEvent("knowledge_gap_verified", { groupId: id, passed: verification.passed, ran: verification.ran });
      res.json({ verification });
    } catch (error) { sendError(res, error); }
  });
}

export function createDefaultGapVerifier({ store, embedText, embeddingModel }) {
  return async () => {
    const { searchApprovedKnowledge } = require("../src/agentTools.js");
    const { getKnowledgeReranker } = require("../src/knowledgeRerank.js");
    const search = createGapSearch({ searchApprovedKnowledge, store, embedText, embeddingModel, knowledgeReranker: getKnowledgeReranker() });
    // Agent / grounding verification needs a live model key; not wired here.
    return { search, agentVerifier: null };
  };
}

export { GAP_STATUS_LABELS, GAP_REASON_LABELS };
