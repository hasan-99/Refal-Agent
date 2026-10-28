// Knowledge Gaps: Edge-side recording of one gap event.
//
// Called by POST /knowledge-gaps/events (index.ts) with the service-role
// client. The worker has already redacted the text; everything is validated and
// redacted AGAIN here because this is the trust boundary in front of storage.
// Off the customer reply path: the worker never awaits this on a reply.

import {
  GAP_GROUPING, GAP_REASONS, classifyExpiredUpgrade, containsObviousPii, gapFingerprint, gapTitle, languageCode,
  questionAspects, redactGapText, decideGapGroup, detectSensitiveTopics, isBlockingTopic, toUnitVector
} from "./knowledgeGapPolicy.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CODE = /^[A-Za-z0-9_:.,-]{0,120}$/u;
export const RATE_LIMIT_SECONDS = 600;

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function code(value, max = 120) {
  const candidate = text(value, max);
  return SAFE_CODE.test(candidate) ? candidate : "";
}

function uuidOrNull(value) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function boundedList(value, max, map) {
  return (Array.isArray(value) ? value : []).slice(0, max).map(map).filter((item) => item !== null && item !== undefined && item !== "");
}

// Strict allowlist. Unknown fields are dropped; free text is re-redacted.
export function sanitizeGapEventInput(body = {}) {
  const question = redactGapText(body.question, 500);
  if (!question || containsObviousPii(question)) return { ok: false, error: "A redacted question is required." };
  const reason = GAP_REASONS.includes(body.reason) ? body.reason : null;
  if (!reason) return { ok: false, error: "Unknown knowledge gap reason." };
  const category = /^[a-z_]{1,40}$/u.test(String(body.category || "")) ? body.category : "general";
  const embedding = toUnitVector(body.embedding, GAP_GROUPING.dimensions);
  const searchQueries = boundedList(body.searchQueries, 6, (value) => redactGapText(value, 300));
  const topChunks = boundedList(body.topChunks, 10, (item) => {
    const id = uuidOrNull(item?.id) || code(item?.id, 80);
    if (!id) return null;
    return { id, rank: Number.isInteger(item?.rank) ? item.rank : null, relevance: Number.isFinite(item?.relevance) ? Number(item.relevance) : null,
      retrievalRank: Number.isFinite(item?.retrievalRank) ? Number(item.retrievalRank) : null,
      documentId: uuidOrNull(item?.documentId), validUntil: text(item?.validUntil, 40) || null };
  });
  const candidateIds = boundedList(body.candidateIds, 20, (value) => uuidOrNull(value) || code(value, 80) || null);
  return {
    ok: true,
    value: {
      userId: text(body.userId, 200),
      sourceTurnId: uuidOrNull(body.sourceTurnId),
      traceId: code(body.traceId, 80),
      question,
      searchQuery: redactGapText(body.searchQuery, 500),
      language: languageCode(body.language),
      intent: code(body.intent, 60),
      intents: boundedList(body.intents, 8, (value) => code(value, 60)),
      category,
      outcome: code(body.outcome, 40) || "unknown",
      reasonCode: code(body.reasonCode, 120),
      reason,
      suspectedReason: GAP_REASONS.includes(body.suspectedReason) ? body.suspectedReason : "",
      confidence: ["high", "medium", "low"].includes(body.confidence) ? body.confidence : "low",
      searchRan: body.searchRan === true,
      searchQueries,
      topChunks,
      candidateIds,
      candidateCount: Number.isInteger(body.candidateCount) && body.candidateCount >= 0 ? Math.min(body.candidateCount, 1000) : 0,
      rerank: { ran: body.rerank?.ran === true, status: code(body.rerank?.status, 40) || null },
      groundingRejected: body.groundingRejected === true,
      rejectionReasons: boundedList(body.rejectionReasons, 12, (value) => code(value, 60)),
      responseType: code(body.responseType, 40) || "unknown",
      noSafeAnswer: body.noSafeAnswer === true,
      model: code(body.model, 120),
      promptVersion: code(body.promptVersion, 40),
      agentVersion: code(body.agentVersion, 40),
      embeddingModel: text(body.embeddingModel, 160),
      analyticsOnly: body.analyticsOnly === true,
      signals: body.signals && typeof body.signals === "object" && !Array.isArray(body.signals)
        ? Object.fromEntries(Object.entries(body.signals).slice(0, 20).filter(([key, value]) => /^[A-Za-z]{1,40}$/u.test(key)
          && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && SAFE_CODE.test(value.slice(0, 80))))))
        : {},
      embedding
    }
  };
}

async function resolveContactId(supabase, userId) {
  if (!userId) return null;
  const { data, error } = await supabase.from("rafa_contacts").select("id").eq("whatsapp_jid", userId).maybeSingle();
  if (error) return null;
  return uuidOrNull(data?.id);
}

export async function recordKnowledgeGapEvent(supabase, body, { rateLimitSeconds = RATE_LIMIT_SECONDS } = {}) {
  const parsed = sanitizeGapEventInput(body);
  if (!parsed.ok) return { recorded: false, error: parsed.error };
  const event = parsed.value;
  const contactId = await resolveContactId(supabase, event.userId);

  let reason = event.reason;
  let expiredMatches = [];
  if (reason === "missing_knowledge") {
    const { data, error } = await supabase.rpc("rafa_knowledge_gap_expired_matches", { p_query: event.searchQuery || event.question, p_limit: 5 });
    if (!error && Array.isArray(data)) expiredMatches = data.map((row) => row.chunk_id).filter((id) => uuidOrNull(id));
    reason = classifyExpiredUpgrade(reason, expiredMatches.length);
  }

  const aspects = questionAspects(event.question);
  let decision = { groupId: null, decision: "new_group", bestSimilarity: null };
  if (event.embedding) {
    const { data, error } = await supabase.rpc("rafa_match_knowledge_gap_groups", { p_embedding: event.embedding, p_limit: GAP_GROUPING.candidateLimit });
    if (error) throw error;
    decision = decideGapGroup({ category: event.category, reason, aspects }, Array.isArray(data) ? data : []);
  }

  const sensitive = detectSensitiveTopics(event.question, event.intents);
  const newGroup = {
    title: gapTitle(event.question), category: event.category, intent: event.intent, facets: aspects.facets, objects: aspects.objects,
    sensitive_topics: sensitive, blocking: isBlockingTopic({ intent: event.intent, category: event.category, intents: event.intents }),
    analytics_only: event.analyticsOnly || reason === "unsupported_request", embedding_model: event.embeddingModel
  };
  const payload = {
    contact_id: contactId, source_turn_id: event.sourceTurnId, trace_id: event.traceId,
    question_redacted: event.question, search_query_redacted: event.searchQuery, question_fingerprint: gapFingerprint(event.question),
    language: event.language, intent: event.intent, category: event.category, outcome: event.outcome, reason_code: event.reasonCode,
    reason, suspected_reason: event.suspectedReason, confidence: event.confidence, search_ran: event.searchRan,
    search_queries: event.searchQueries, top_chunks: event.topChunks, candidate_ids: event.candidateIds, candidate_count: event.candidateCount,
    rerank: event.rerank, grounding_rejected: event.groundingRejected, rejection_reasons: event.rejectionReasons,
    response_type: event.responseType, no_safe_answer: event.noSafeAnswer, model: event.model, prompt_version: event.promptVersion,
    agent_version: event.agentVersion,
    signals: { ...event.signals, groupingDecision: decision.decision, bestSimilarity: decision.bestSimilarity === null ? null : Number(decision.bestSimilarity.toFixed(4)),
      expiredMatches: expiredMatches.length }
  };
  const { data, error } = await supabase.rpc("rafa_record_knowledge_gap_event", {
    p_group_id: decision.groupId, p_new_group: newGroup, p_event: payload, p_embedding: event.embedding, p_rate_limit_seconds: rateLimitSeconds
  });
  if (error) throw error;
  return { recorded: data?.suppressed !== true, suppressed: data?.suppressed === true, groupId: data?.groupId || null,
    created: data?.created === true, reopened: data?.reopened === true, reason, grouping: decision.decision };
}
