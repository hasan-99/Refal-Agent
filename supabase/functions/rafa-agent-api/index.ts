import { createClient } from "npm:@supabase/supabase-js@2";
import { createProviderSecretLoader } from "./providerSecret.mjs";
import { hasConfirmationEventId, isAllowedAppointmentTransition, updateAppointmentIfStatusMatches } from "./appointmentStateMachine.mjs";
import { areAdjacentConsentTurns, buildSafeHistoryInsert, hasPurposeBoundAutomatedReminderConsent, hasPurposeBoundFollowUpConsent, mergeActiveHandover, sanitizeHandoverSummary } from "./handoverPersistence.mjs";
import { containsUnconsentedContactCommitment, containsProhibitedConstructionEstimate, containsForbiddenCredentialRequest } from "./responsePolicy.mjs";
// Was a hand-copied regex in this file that had drifted into a fail-open:
// it let "100% success rate", "موافقة مضمونة" and "Σίγουρη έγκριση" through,
// and wrongly blocked "I cannot provide tax advice". Now a generated,
// drift-tested extract of src/refalcoAnswer.js (npm run edge:mirrors).
import { containsProhibitedClaim } from "./refalcoAnswer.mjs";
import { buildBrainPrompt as buildOperatorPrompt, DEFAULT_COMPANY_IDENTITY } from "./brainPrompt.mjs";
import { RESPONSE_STYLE_DEFAULTS, responseStyleInstruction, validateResponseStyle } from "./responseStyle.mjs";
import { validateCompanyIdentity } from "./companyIdentitySettings.mjs";
import { BUSINESS_GUIDANCE_DEFAULTS, businessGuidanceInstruction, validateBusinessGuidance } from "./businessGuidance.mjs";
import { listDynamicData, mutateDynamicData, performDynamicAction } from "./dynamicData.mjs";
import { validateCustomerLeadFields } from "./dynamicActionValidation.mjs";
import { persistDynamicActionAlert } from "./dynamicActionAlert.mjs";
import { attachKnowledgePolicyMetadata } from "./knowledgePolicyMetadata.mjs";
import { resolveTrustedKnowledgeEvidence } from "./trustedKnowledgeEvidence.mjs";
import { validateSalesOfferMetadata, validateSpecialistOfferMetadata } from "./salesOfferMetadata.mjs";
import { canRetryHandoverReview, closeHandoverDeliverySafely, ledgerPatchForClosedHandover, ledgerPatchForExistingNotification, ledgerPatchForNotificationResult, ledgerPatchForRetryMismatch } from "./handoverDeliveryState.mjs";
import { canClaimP65TestNotification, canCreateP65TestNotification, controlledP65Recipient, isSyntheticP65Handover } from "./p65TestRouting.mjs";
import { consumeSharedRateLimit } from "./rateLimit.mjs";
import { isPromptWithinTokenCeiling } from "./promptBudget.mjs";
import { CRM_PROFILE_GROUPS, crmRowToAgentFacts, isExplicitCrmCorrection, isSelfIdentifiedCrmName, normalizeCrmStoredValue, validateCrmValueAgainstMessage } from "./crmLeadProfile.mjs";
import { claimInboundMessage, completeInboundMessage } from "./inboundMessageReceipts.mjs";
import { isAllowedReminderTransition, reminderPatchForState } from "./reminderDeliveryState.mjs";
import { redactAuditEventFields, sanitizeAgentOperationalFields } from "./auditEventPrivacy.mjs";
import { sanitizeControlledInspection } from "./controlledDiagnostics.mjs";
import { containsSensitiveOutputValue } from "./sensitiveOutputPolicy.mjs";
import { fetchJsonWithTimeout, ProviderTimeoutError } from "./providerTransport.mjs";
import { normalizeOpenRouterUsage } from "./providerUsage.mjs";
import { detectMessageLanguage, languageInstruction } from "./language.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-rafa-api-secret",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
const loadProviderSecret = createProviderSecretLoader({
  readVaultSecret: async () => {
    const { data, error } = await supabase.schema("vault").from("decrypted_secrets")
      .select("decrypted_secret").eq("name", "openrouter_api_key").maybeSingle();
    if (error) throw error;
    return data?.decrypted_secret || "";
  },
  readEnvironmentSecret: () => Deno.env.get("OPENROUTER_API_KEY") || ""
});
const defaultChatModel = "openai/gpt-6-luna";
const legacyChatModels = new Set(["inclusionai/ling-3.0-flash-sante:free", "openrouter/free", "deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-27b:free"]);
const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";

async function requireFollowUpConsent(handoverId: string) {
  const { data: handover, error: handoverError } = await supabase.from("rafa_handovers").select("contact_id").eq("id", handoverId).maybeSingle();
  if (handoverError) throw handoverError;
  if (!handover?.contact_id) throw new HttpError("Specialist follow-up consent is required.", 403);
  const { data: consent, error: consentError } = await supabase.from("rafa_contact_consents").select("state,source_turn_id").eq("contact_id", handover.contact_id).eq("consent_type", "follow_up").maybeSingle();
  if (consentError) throw consentError;
  if (consent?.state !== "granted" || !consent.source_turn_id) throw new HttpError("Specialist follow-up consent is required.", 403);
  const { data: sourceTurn, error: turnError } = await supabase.from("rafa_conversation_turns").select("id,metadata").eq("id", consent.source_turn_id).maybeSingle();
  if (turnError) throw turnError;
  if (!hasPurposeBoundFollowUpConsent(consent, sourceTurn)) throw new HttpError("Specialist follow-up consent is required.", 403);
}

function resolveChatModel(value: unknown) {
  const model = String(value || "").trim();
  return !model || legacyChatModels.has(model) ? defaultChatModel : model;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    const apiSecret = req.headers.get("x-rafa-api-secret") || "";
    if (!apiSecret) return json({ error: "Unauthorized" }, 401);
    const { data: authorized, error: authError } = await supabase.rpc("rafa_validate_api_secret", {
      p_secret: apiSecret
    });
    if (authError || authorized !== true) return json({ error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/rafa-agent-api/, "").split("/").filter(Boolean);

    // M4: service-role access stays inside this authenticated Edge gateway.
    // Dashboard operator authorization is checked by its trusted server route;
    // model callers can only use the read-only GET surface.
    if (parts[0] === "dynamic-data" && parts[1]) {
      const kind = decodeURIComponent(parts[1]);
      if (req.method === "GET") {
        const result = await listDynamicData(supabase, kind, Object.fromEntries(url.searchParams.entries()));
        return json(result);
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const row = await mutateDynamicData(supabase, kind, body);
        return json({ row }, body.operation === "create" ? 201 : 200);
      }
    }

    if (parts[0] === "dynamic-actions" && parts[1] && req.method === "POST" && parts.length === 2) {
      const name = decodeURIComponent(parts[1]);
      const body = await req.json().catch(() => ({}));
      const { contact, sourceTurnId } = await workflowContact(body);
      const result = await performDynamicAction(supabase, name, {
        ...body,
        contactId: contact.contactId,
        sourceTurnId
      }, () => runDynamicAction(name, { ...body, sourceTurnId, contact }));
      if (result.status === "pending") {
        try {
          await logWorkflowAudit(contact.contactId, "dynamic_action_reconciliation_required", {
            tool: name,
            receipt_id: result.receiptId || null,
            reason: result.reasonCode || "duplicate_pending"
          }, "system");
        } catch (alertError) {
          console.error("dynamic action reconciliation audit could not be persisted", { tool: name, error: String(alertError).slice(0, 160) });
        }
        try {
          await persistDynamicActionAlert(supabase, {
            contactId: contact.contactId,
            sourceTurnId,
            tool: name,
            receiptId: result.receiptId || null,
            reasonCode: result.reasonCode || "outcome_uncertain"
          });
        } catch (alertError) {
          console.error("dynamic action operator alert could not be persisted", { tool: name, error: String(alertError).slice(0, 160) });
        }
      }
      return json({ ...result, userSafeSummary: result.status === "confirmed" ? result.result?.userSafeSummary || "Confirmed." : result.status === "pending" ? "The request is still being checked." : "The request could not be confirmed." }, result.status === "confirmed" ? 200 : 202);
    }

    if (parts[0] === "rate-limits" && parts[1] === "consume" && req.method === "POST" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      const result = await consumeSharedRateLimit(supabase, body);
      return json(result);
    }

    if (parts[0] === "crm" && parts[1] === "profile" && req.method === "POST" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      const userId = String(body.userId || "").trim().slice(0, 200);
      const field = String(body.field || "");
      const rawValue = typeof body.rawValue === "string" ? body.rawValue : "";
      const normalizedValue = typeof body.normalizedValue === "string" ? body.normalizedValue : "";
      const sourceTurnId = String(body.sourceTurnId || "");
      if (!userId || !Object.hasOwn(CRM_PROFILE_GROUPS, field) || !rawValue || rawValue.length > 500
        || !normalizedValue || normalizedValue.length > 500 || normalizeCrmStoredValue(rawValue) !== normalizedValue || !isUuid(sourceTurnId)) {
        throw new HttpError("A supported CRM field and verified source turn are required.", 400);
      }
      const { data: contact, error: contactError } = await supabase.from("rafa_contacts").select("id").eq("whatsapp_jid", userId).maybeSingle();
      if (contactError) throw contactError;
      if (!contact?.id) throw new HttpError("Customer contact was not found.", 404);
      const { data: sourceTurn, error: sourceError } = await supabase.from("rafa_conversation_turns").select("id,message")
        .eq("id", sourceTurnId).eq("contact_id", contact.id).maybeSingle();
      if (sourceError) throw sourceError;
      if (!sourceTurn || !validateCrmValueAgainstMessage(field, rawValue, sourceTurn.message)
        || (field === "name" && !isSelfIdentifiedCrmName(sourceTurn.message, rawValue))) {
        throw new HttpError("CRM value must be stated affirmatively in the linked customer turn.", 400);
      }
      const correction = isExplicitCrmCorrection(sourceTurn.message);
      const { data: saved, error: writeError } = await supabase.rpc("refal_save_lead_profile_field", {
        p_contact_id: contact.id,
        p_field: field,
        p_raw_value: rawValue,
        p_normalized_value: normalizedValue,
        p_source_turn_id: sourceTurnId,
        p_captured_at: new Date().toISOString(),
        p_explicit_correction: correction
      });
      if (writeError) throw writeError;
      if (!saved || !["saved", "correction_needed"].includes(saved.status)) throw new Error("CRM profile persistence was not confirmed.");
      return json({ status: saved.status, field: saved.field || field.toLowerCase(), correctionFields: Array.isArray(saved.correction_fields) ? saved.correction_fields : [] });
    }

    if (parts[0] === "settings" && parts[1] === "booking-policy" && parts.length === 2) {
      if (req.method === "GET") {
        const { data, error } = await supabase.from("rafa_settings").select("value,updated_at").eq("key", "booking_policy").maybeSingle();
        if (error) throw error;
        return json({ policy: data?.value || null, updatedAt: data?.updated_at || null });
      }
      if (req.method === "PUT") {
        const body = await req.json().catch(() => ({}));
        let policy;
        try { policy = validateBookingPolicy(body.policy); }
        catch (error) { throw new HttpError(error instanceof Error ? error.message : "Invalid booking policy.", 400); }
        const { data, error } = await supabase.from("rafa_settings").upsert({ key: "booking_policy", value: policy }, { onConflict: "key" }).select("value,updated_at").single();
        if (error) throw error;
        return json({ policy: data.value, updatedAt: data.updated_at });
      }
    }

    if (parts[0] === "settings" && parts[1] === "response-style" && parts.length === 2) {
      if (req.method === "GET") {
        const { data, error } = await supabase.from("rafa_settings").select("value,updated_at").eq("key", "response_style").maybeSingle();
        if (error) throw error;
        return json({ style: validateResponseStyle(data?.value || RESPONSE_STYLE_DEFAULTS), updatedAt: data?.updated_at || null });
      }
      if (req.method === "PUT") {
        const body = await req.json().catch(() => ({}));
        let style;
        try { style = validateResponseStyle(body.style); }
        catch (error) { throw new HttpError(error instanceof Error ? error.message : "Invalid response style.", 400); }
        const { data, error } = await supabase.from("rafa_settings").upsert({ key: "response_style", value: style }, { onConflict: "key" }).select("value,updated_at").single();
        if (error) throw error;
        return json({ style: validateResponseStyle(data.value), updatedAt: data.updated_at });
      }
    }

    if (parts[0] === "settings" && parts[1] === "company-identity" && parts.length === 2) {
      if (req.method === "GET") {
        const { data, error } = await supabase.from("rafa_settings").select("value,updated_at").eq("key", "company_identity").maybeSingle();
        if (error) throw error;
        let identity;
        try { identity = validateCompanyIdentity(data?.value || DEFAULT_COMPANY_IDENTITY); }
        catch { identity = DEFAULT_COMPANY_IDENTITY; }
        return json({ identity, updatedAt: data?.updated_at || null });
      }
      if (req.method === "PUT") {
        const body = await req.json().catch(() => ({}));
        let identity;
        try { identity = validateCompanyIdentity(body.identity); }
        catch (error) { throw new HttpError(error instanceof Error ? error.message : "Invalid company identity.", 400); }
        const { data, error } = await supabase.from("rafa_settings").upsert({ key: "company_identity", value: identity }, { onConflict: "key" }).select("value,updated_at").single();
        if (error) throw error;
        return json({ identity: validateCompanyIdentity(data.value), updatedAt: data.updated_at });
      }
    }

    if (parts[0] === "settings" && parts[1] === "business-guidance" && parts.length === 2) {
      if (req.method === "GET") {
        const { data, error } = await supabase.from("rafa_settings").select("value,updated_at").eq("key", "business_guidance").maybeSingle();
        if (error) throw error;
        let guidance;
        try { guidance = validateBusinessGuidance(data?.value || BUSINESS_GUIDANCE_DEFAULTS); }
        catch { guidance = BUSINESS_GUIDANCE_DEFAULTS; }
        return json({ guidance, updatedAt: data?.updated_at || null });
      }
      if (req.method === "PUT") {
        const body = await req.json().catch(() => ({}));
        let guidance;
        try { guidance = validateBusinessGuidance(body.guidance); }
        catch (error) { throw new HttpError(error instanceof Error ? error.message : "Invalid business guidance.", 400); }
        const { data, error } = await supabase.from("rafa_settings").upsert({ key: "business_guidance", value: guidance }, { onConflict: "key" }).select("value,updated_at").single();
        if (error) throw error;
        return json({ guidance: validateBusinessGuidance(data.value), updatedAt: data.updated_at });
      }
    }

    if (parts[0] === "knowledge" && parts[1] === "search" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const query = String(body.query || "").trim().slice(0, 1000);
      if (!query) return json({ error: "A search query is required." }, 400);
      const matchCount = Math.min(20, Math.max(1, Number(body.matchCount) || 6));
      const embedding = Array.isArray(body.embedding) && body.embedding.length === 2048 && body.embedding.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
        ? `[${body.embedding.join(",")}]`
        : null;
      const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel.slice(0, 160) : "";
      // A worker that reranks asks for a wider candidate window (candidateCount,
      // max 50) through the additive v2 RPC. Callers that do not send it keep
      // the v1 path unchanged, and any v2 failure falls back to v1.
      const candidateCount = Number.isInteger(body.candidateCount) ? Math.min(50, Math.max(1, body.candidateCount)) : null;
      const v1 = () => embedding
        ? supabase.rpc("rafa_hybrid_search_knowledge", {
          p_query: query,
          p_embedding: embedding,
          p_embedding_model: embeddingModel,
          p_match_count: matchCount
        })
        : supabase.rpc("rafa_search_knowledge", {
          p_query: query,
          p_match_count: matchCount
        });
      let { data, error } = embedding && candidateCount
        ? await supabase.rpc("rafa_hybrid_search_knowledge_v2", {
          p_query: query,
          p_embedding: embedding,
          p_embedding_model: embeddingModel,
          p_match_count: candidateCount,
          p_candidate_count: Math.max(candidateCount, 30)
        })
        : await v1();
      if (error && embedding && candidateCount) ({ data, error } = await v1());
      if (error) throw error;
      const candidateRows = data || [];
      const candidateIds = candidateRows.map((row: { chunk_id?: string }) => row.chunk_id).filter((id: unknown): id is string => typeof id === "string");
      const { data: expanded, error: expansionError } = await supabase.rpc("rafa_expand_knowledge_sections", {
        p_chunk_ids: candidateIds,
        p_max_chunks: 80
      });
      if (expansionError) throw expansionError;
      // Governance metadata is fetched server-side for deterministic M5 policy
      // checks. It is carried separately from the model-safe evidence block.
      return json({ results: await attachKnowledgePolicyMetadata(supabase, expanded || candidateRows) });
    }

    if (parts[0] === "agent" && parts[1] === "sessions" && req.method === "GET" && parts.length === 2) {
      return json({ sessions: await listAgentSessions() });
    }

    if (parts[0] === "agent" && parts[1] === "generate" && req.method === "POST" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      return json(await generateAgentReply(body));
    }

    if (parts[0] === "agent" && parts[1] === "sessions" && req.method === "POST" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      return json({ session: await createAgentSession(body) });
    }

    if (parts[0] === "agent" && parts[1] === "sessions" && parts[2] && req.method === "GET" && parts.length === 3) {
      return json(await getAgentSession(decodeURIComponent(parts[2])));
    }

    if (parts[0] === "agent" && parts[1] === "sessions" && parts[2] && req.method === "PUT" && parts.length === 3) {
      const body = await req.json().catch(() => ({}));
      return json({ session: await updateAgentSession(decodeURIComponent(parts[2]), body) });
    }

    if (parts[0] === "agent" && parts[1] === "sessions" && parts[2] && req.method === "DELETE" && parts.length === 3) {
      return json({ deleted: await deleteAgentSession(decodeURIComponent(parts[2])) });
    }

    if (parts[0] === "agent" && parts[1] === "sessions" && parts[2] && parts[3] === "messages" && req.method === "POST") {
      const body = await req.json();
      return json({ message: await addAgentMessage(decodeURIComponent(parts[2]), body) });
    }

    if (parts[0] === "agent" && parts[1] === "memories" && req.method === "GET") {
      return json({ memories: await listAgentMemories() });
    }

    if (parts[0] === "agent" && parts[1] === "memories" && req.method === "POST") {
      const body = await req.json();
      return json({ memory: await createAgentMemory(body) });
    }

    if (parts[0] === "agent" && parts[1] === "memories" && parts[2] && req.method === "DELETE") {
      return json({ deleted: await deleteAgentMemory(decodeURIComponent(parts[2])) });
    }

    if (parts[0] === "contacts" && req.method === "GET" && parts.length === 1) {
      const includeHistory = url.searchParams.get("includeHistory") === "true";
      return json({ users: await listUsers(includeHistory) });
    }

    if (parts[0] === "contacts" && parts[1] === "ensure" && req.method === "POST") {
      const body = await req.json();
      return json({ user: await ensureUser(String(body.userId || "")) });
    }

    if (parts[0] === "contacts" && parts[1] && parts[2] === "admin-correction" && req.method === "POST") {
      const userId = decodeURIComponent(parts[1]);
      const body = await req.json().catch(() => ({}));
      const allowed = new Set(["nameOverride","phoneOverride","needOverride","conversationSummary"]);
      const changes = body?.contact;
      const expected = body?.expected;
      const actor = String(body?.actor || "").trim().slice(0, 200);
      if (!validWhatsAppJid(userId) || !changes || typeof changes !== "object" || Array.isArray(changes)
        || !expected || typeof expected !== "object" || Array.isArray(expected)
        || Object.keys(changes).length === 0 || Object.keys(changes).some((field) => !allowed.has(field))
        || Object.keys(expected).some((field) => !allowed.has(field)) || !actor) {
        throw new HttpError("Invalid contact correction request.", 400);
      }
      const { data, error } = await supabase.rpc("refal_correct_contact_profile", {
        p_whatsapp_jid: userId, p_expected: expected, p_changes: changes, p_actor: actor
      });
      if (error) throw error;
      if (data?.status === "stale") throw new HttpError("This contact changed since you opened it. Reload the current values before saving.", 409);
      if (data?.status === "not_found") throw new HttpError("User not found.", 404);
      if (data?.status !== "saved") throw new HttpError("Contact correction was not confirmed.", 502);
      return json({ ok: true, profile: data.profile });
    }

    if (parts[0] === "contacts" && parts[1] && req.method === "GET") {
      const includeHistory = url.searchParams.get("includeHistory") !== "false";
      return json({ user: await getUser(decodeURIComponent(parts[1]), includeHistory) });
    }

    if (parts[0] === "contacts" && parts[1] && req.method === "PUT") {
      const body = await req.json();
      return json({ user: await updateUser(decodeURIComponent(parts[1]), body) });
    }

    if (parts[0] === "handovers" && parts[1] && req.method === "GET" && parts.length === 2) {
      const handoverId = decodeURIComponent(parts[1]);
      if (!isUuid(handoverId)) throw new HttpError("Invalid handover ID.", 400);
      const { data, error } = await supabase.from("rafa_handovers").select("id,status").eq("id", handoverId).maybeSingle();
      if (error) throw error;
      return json({ handover: data || null });
    }

    if (parts[0] === "contacts" && parts[1] && parts[2] === "history" && req.method === "POST") {
      const userId = decodeURIComponent(parts[1]);
      const body = await req.json();
      const user = await ensureUser(userId);
      const turn = await addHistory(user, body);
      return json({ user, turn });
    }

    if (parts[0] === "contacts" && parts[1] && parts[2] === "history" && parts[3] && req.method === "PATCH" && parts.length === 4) {
      const userId = decodeURIComponent(parts[1]);
      const turnId = decodeURIComponent(parts[3]);
      const body = await req.json().catch(() => ({}));
      return json({ turn: await updateHistoryTurn(userId, turnId, body) });
    }

    if (parts[0] === "workflows" && parts[1] && ["POST", "PUT"].includes(req.method)) {
      const body = await req.json().catch(() => ({}));
      return json(await persistWorkflow(parts[1], body));
    }

    if (parts[0] === "blocks" && parts[1] === "check" && req.method === "GET") {
      const userId = String(url.searchParams.get("userId") || "");
      if (!validWhatsAppJid(userId)) throw new HttpError("Invalid WhatsApp contact.", 400);
      const { data, error } = await supabase.from("rafa_contact_blocks").select("id,reason,category,created_at").in("whatsapp_jid", blockIdentities(userId)).eq("status", "active").limit(1).maybeSingle();
      if (error) throw error;
      return json({ blocked: Boolean(data), block: data || null });
    }

    if (parts[0] === "messages" && parts[1] === "claim" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const userId = String(body.userId || "");
      const messageId = String(body.messageId || "").trim();
      if (!validWhatsAppJid(userId) || !messageId || messageId.length > 200) throw new HttpError("A valid WhatsApp message identity is required.", 400);
      const leaseToken = crypto.randomUUID();
      return json(await claimInboundMessage(supabase, { userId, messageId, leaseToken }));
    }

    if (parts[0] === "messages" && parts[1] === "complete" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const userId = String(body.userId || "");
      const messageId = String(body.messageId || "").trim();
      const leaseToken = String(body.leaseToken || "");
      if (!validWhatsAppJid(userId) || !messageId || messageId.length > 200 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken)) throw new HttpError("A valid WhatsApp message identity and receipt lease are required.", 400);
      return json(await completeInboundMessage(supabase, { userId, messageId, leaseToken }));
    }

    if (parts[0] === "blocks" && req.method === "GET" && parts.length === 1) {
      const { data, error } = await supabase.from("rafa_contact_blocks").select("*").order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return json({ blocks: data || [] });
    }

    if (parts[0] === "blocks" && req.method === "POST" && parts.length === 1) {
      const body = await req.json().catch(() => ({}));
      const whatsappJid = String(body.userId || "").trim();
      const reason = String(body.reason || "").trim().slice(0, 500);
      const category = String(body.category || "other");
      const createdBy = String(body.createdBy || "admin").trim().slice(0, 200);
      if (!validWhatsAppJid(whatsappJid) || !reason || !["harassment", "spam", "threat", "other"].includes(category)) throw new HttpError("A valid contact, reason, and block category are required.", 400);
      const { data: activeBlock, error: activeBlockError } = await supabase.from("rafa_contact_blocks").select("id").in("whatsapp_jid", blockIdentities(whatsappJid)).eq("status", "active").limit(1).maybeSingle();
      if (activeBlockError) throw activeBlockError;
      if (activeBlock) throw new HttpError("This contact is already blocked.", 409);
      const { data, error } = await supabase.from("rafa_contact_blocks").insert({ whatsapp_jid: whatsappJid, reason, category, created_by: createdBy }).select("*").single();
      if (error?.code === "23505") throw new HttpError("This contact is already blocked.", 409);
      if (error) throw error;
      await logEvent("contact_blocked", { contactId: whatsappJid, blockId: data.id, category, reason, actor: createdBy });
      return json({ block: data }, 201);
    }

    if (parts[0] === "blocks" && parts[1] && req.method === "PATCH" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      if (body.status !== "unblocked") throw new HttpError("Only unblocking is supported.", 400);
      const reviewer = String(body.reviewer || "admin").trim().slice(0, 200);
      const unblockReason = String(body.reason || "").trim().slice(0, 500);
      const { data, error } = await supabase.from("rafa_contact_blocks").update({ status: "unblocked", reviewed_by: reviewer, reviewed_at: new Date().toISOString(), unblock_reason: unblockReason || null }).eq("id", parts[1]).eq("status", "active").select("*").maybeSingle();
      if (error) throw error;
      if (!data) throw new HttpError("Block is missing or already inactive.", 409);
      await logEvent("contact_unblocked", { contactId: data.whatsapp_jid, blockId: data.id, actor: reviewer });
      return json({ block: data });
    }

    if (parts[0] === "appointments" && req.method === "GET" && parts.length === 1) {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
      const status = url.searchParams.get("status");
      let query = supabase.from("rafa_appointments")
        .select("*,contact:rafa_contacts!rafa_appointments_contact_id_fkey(phone,profile),reminders:rafa_reminder_jobs(*)")
        .order("starts_at", { ascending: true })
        .limit(limit);
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      return json({ appointments: data || [] });
    }

    if (parts[0] === "appointments" && parts[1] && req.method === "GET" && parts.length === 2) {
      if (!isUuid(parts[1])) throw new HttpError("Invalid appointment ID.", 400);
      const { data, error } = await supabase.from("rafa_appointments")
        .select("*").eq("id", parts[1]).maybeSingle();
      if (error) throw error;
      return json({ appointment: data || null }, data ? 200 : 404);
    }

    if (parts[0] === "appointments" && req.method === "POST" && parts.length === 1) {
      const body = await req.json().catch(() => ({}));
      const appointment = await createAppointment(body);
      if (appointment.conflict) return json({ error: "That idempotency key is already used for a different appointment." }, 409);
      return json({ appointment, created: appointment.created }, appointment.created ? 201 : 200);
    }

    if (parts[0] === "appointments" && parts[1] && req.method === "PUT" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      return json({ appointment: await updateAppointment(decodeURIComponent(parts[1]), body) });
    }

    if (parts[0] === "appointments" && parts[1] && parts[2] === "reminders" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const reminder = await createReminder(decodeURIComponent(parts[1]), body);
      if (reminder.conflict) return json({ error: "That idempotency key is already used for a different reminder." }, 409);
      return json({ reminder, created: reminder.created }, reminder.created ? 201 : 200);
    }

    if (parts[0] === "reminders" && parts[1] === "claim" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 25));
      const { data, error } = await supabase.rpc("rafa_claim_due_reminders", { p_limit: limit });
      if (error) throw error;
      return json({ reminders: data || [] });
    }

    if (parts[0] === "reminders" && parts[1] && req.method === "PUT" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      return json({ reminder: await updateReminder(decodeURIComponent(parts[1]), body) });
    }

    if (parts[0] === "notifications" && parts[1] === "test-handover" && req.method === "POST" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      const testRunId = String(body.testRunId || "").toLowerCase();
      if (!isUuid(testRunId)) throw new HttpError("A valid test run ID is required.", 400);
      const recipient = controlledP65Recipient(Deno.env.get("RAFA_P65_TEST_RECIPIENT"));
      if (!recipient) throw new HttpError("The controlled P6.5 recipient is not configured.", 503);
      const idempotencyKey = `p65-handover:${testRunId}`;
      const { data: previous, error: previousError } = await supabase.from("rafa_notification_jobs")
        .select("id,handover_id,kind,recipient,payload,status,idempotency_key")
        .eq("idempotency_key", idempotencyKey).maybeSingle();
      if (previousError) throw previousError;
      if (previous) {
        const { data: previousHandover, error: previousHandoverError } = await supabase.from("rafa_handovers")
          .select("id,contact_id,department,priority,status,summary")
          .eq("id", previous.handover_id).maybeSingle();
        if (previousHandoverError) throw previousHandoverError;
        const { data: previousContact, error: previousContactError } = previousHandover
          ? await supabase.from("rafa_contacts").select("whatsapp_jid").eq("id", previousHandover.contact_id).maybeSingle()
          : { data: null, error: null };
        if (previousContactError) throw previousContactError;
        if (!canCreateP65TestNotification({ kind: previous.kind, testRunId, idempotencyKey, handover: previousHandover, contact: previousContact, recipient: previous.recipient }) || previous.payload?.p65TestRunId !== testRunId) {
          throw new HttpError("The test idempotency key is already used for a different notification.", 409);
        }
        return json({ notification: previous, handover: previousHandover, created: false });
      }

      const syntheticUserId = `p65test-${testRunId}@lid`;
      const { handover } = await persistWorkflow("handover", {
        userId: syntheticUserId,
        department: "general",
        priority: "normal",
        status: "open",
        summary: {
          p65TestRunId: testRunId,
          intent: "p6_5_controlled_delivery_test",
          need: "Synthetic internal notification verification. Do not contact a customer.",
          customer: { name: "REFAL P6.5 test" }
        }
      });
      const { data: contact, error: contactError } = await supabase.from("rafa_contacts")
        .select("whatsapp_jid").eq("id", handover.contact_id).maybeSingle();
      if (contactError) throw contactError;
      if (!isSyntheticP65Handover(handover, contact, testRunId)) throw new HttpError("The synthetic handover did not pass its test marker checks.", 409);
      const payload = {
        department: "general",
        priority: "normal",
        intent: "p6_5_controlled_delivery_test",
        name: "REFAL P6.5 test",
        need: "Synthetic internal notification verification. Do not contact a customer.",
        p65TestRunId: testRunId
      };
      const { data: notification, error: notificationError } = await supabase.from("rafa_notification_jobs").insert({
        handover_id: handover.id,
        channel: "email",
        kind: "handover_review",
        recipient,
        payload,
        status: "queued",
        idempotency_key: idempotencyKey
      }).select("*").single();
      if (notificationError?.code === "23505") {
        const { data: concurrent, error: concurrentError } = await supabase.from("rafa_notification_jobs")
          .select("id,handover_id,kind,recipient,payload,status,idempotency_key").eq("idempotency_key", idempotencyKey).single();
        if (concurrentError) throw concurrentError;
        if (concurrent.kind !== "handover_review" || concurrent.handover_id !== handover.id || concurrent.recipient !== recipient || concurrent.payload?.p65TestRunId !== testRunId) throw new HttpError("The test idempotency key is already used for a different notification.", 409);
        return json({ notification: concurrent, handover, created: false });
      }
      if (notificationError) throw notificationError;
      return json({ notification, handover, created: true }, 201);
    }

    if (parts[0] === "notifications" && parts[1] && parts[2] === "claim" && req.method === "POST" && parts.length === 3) {
      const notificationId = decodeURIComponent(parts[1]);
      if (!isUuid(notificationId)) throw new HttpError("Invalid notification ID.", 400);
      const body = await req.json().catch(() => ({}));
      const testRunId = String(body.testRunId || "").toLowerCase();
      if (!isUuid(testRunId)) throw new HttpError("A valid test run ID is required.", 400);
      const configuredRecipient = controlledP65Recipient(Deno.env.get("RAFA_P65_TEST_RECIPIENT"));
      if (!configuredRecipient) throw new HttpError("The controlled P6.5 recipient is not configured.", 503);
      const { data: candidate, error: candidateError } = await supabase.from("rafa_notification_jobs")
        .select("id,handover_id,kind,recipient,payload,status,idempotency_key")
        .eq("id", notificationId).maybeSingle();
      if (candidateError) throw candidateError;
      if (!candidate || !canClaimP65TestNotification({ ...candidate, requestedId: notificationId, testRunId, configuredRecipient })) {
        throw new HttpError("Only the matching controlled P6.5 test notification can be claimed by ID.", 409);
      }
      const { data: claimedRows, error: claimError } = await supabase.rpc("rafa_claim_notification_by_id", {
        p_notification_id: notificationId,
        p_test_run_id: testRunId,
        p_expected_recipient: configuredRecipient
      });
      if (claimError) throw claimError;
      const notification = (claimedRows || [])[0];
      if (!notification) throw new HttpError("The requested notification is not currently eligible for claim.", 409);
      const { data: handover, error: handoverError } = await supabase.from("rafa_handovers")
        .select("status").eq("id", notification.handover_id).maybeSingle();
      if (handoverError) throw new HttpError("Handover status verification is unavailable; the notification was not returned.", 503);
      if (!handover || !canRetryHandoverReview(handover.status)) {
        const { error: cancelError } = await supabase.from("rafa_notification_jobs")
          .update({ status: "cancelled", locked_at: null, last_error: "Synthetic test handover is closed." })
          .eq("id", notificationId).eq("status", "processing");
        if (cancelError) throw cancelError;
        throw new HttpError("The synthetic test handover is closed; notification cancelled.", 409);
      }
      return json({ notification });
    }

    if (parts[0] === "notifications" && req.method === "GET" && parts.length === 1) {
      const status = url.searchParams.get("status");
      let query = supabase.from("rafa_notification_jobs").select("*").order("created_at", { ascending: false }).limit(500);
      if (status) query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      return json({ notifications: data || [] });
    }

    if (parts[0] === "notifications" && parts[1] && parts[2] === "retry" && req.method === "POST" && parts.length === 3) {
      if (!isUuid(parts[1])) throw new HttpError("Invalid notification ID.", 400);
      const { data: candidate, error: candidateError } = await supabase.from("rafa_notification_jobs")
        .select("id,kind,handover_id,status,payload")
        .eq("id", parts[1])
        .in("status", ["failed", "dead"])
        .maybeSingle();
      if (candidateError) throw candidateError;
      if (!candidate) throw new HttpError("Notification is not retryable in its current state.", 409);
      if (candidate.kind === "handover_review" && candidate.payload?.p65TestRunId) throw new HttpError("Controlled P6.5 deliveries are one-shot and cannot be retried because SMTP outcomes may be ambiguous.", 409);
      if (candidate.kind === "handover_review" && candidate.handover_id) {
        const { data: parent, error: parentError } = await supabase.from("rafa_handovers")
          .select("status").eq("id", candidate.handover_id).maybeSingle();
        if (parentError) throw parentError;
        if (!parent || !canRetryHandoverReview(parent.status)) throw new HttpError("A closed handover cannot be retried.", 409);
      }
      const { data, error } = await supabase.from("rafa_notification_jobs").update({ status: "queued", attempts: 0, next_attempt_at: new Date().toISOString(), locked_at: null, last_error: null }).eq("id", parts[1]).in("status", ["failed", "dead"]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) throw new HttpError("Notification is not retryable in its current state.", 409);
      if (data.kind === "handover_review" && data.handover_id) {
        const { error: deliveryError } = await supabase.from("refal_handover_delivery").update({ status: "queued", next_attempt_at: new Date().toISOString(), last_error_code: null, updated_at: new Date().toISOString() }).eq("handover_id", data.handover_id);
        if (deliveryError) throw deliveryError;
      }
      await logEvent("notification_admin_retry", { notificationId: data.id, appointmentId: data.appointment_id || null });
      return json({ notification: data });
    }

    if (parts[0] === "notifications" && req.method === "POST" && parts.length === 1) {
      const body = await req.json().catch(() => ({}));
      const kind = String(body.kind || "");
      const idempotencyKey = String(body.idempotencyKey || "").trim().slice(0, 240);
      const expectedStatus = String(body.expectedAppointmentStatus || "");
      let channel = "";
      let recipient = "";
      let payload: Record<string, unknown> = {};
      let handoverId: string | null = null;
      let status = "queued";
      if (kind === "owner_review") {
        channel = "email";
        recipient = (Deno.env.get("BOOKING_NOTIFY_EMAIL") || "hasan.cy99@gmail.com").trim().slice(0, 320);
        payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
      } else if (kind === "customer_message") {
        channel = "whatsapp";
        recipient = String(body.recipient || "");
        const text = String(body.payload?.text || "").trim();
        if (!validWhatsAppJid(recipient) || !text || text.length > 1500) throw new HttpError("A valid customer and short message are required.", 400);
        payload = { text };
      } else if (kind === "handover_review") {
        channel = "email";
        handoverId = String(body.handoverId || "");
        const testRunId = String(body.p65TestRunId || "").toLowerCase();
        if (testRunId) {
          recipient = controlledP65Recipient(Deno.env.get("RAFA_P65_TEST_RECIPIENT"));
          if (!recipient) throw new HttpError("The controlled P6.5 recipient is not configured.", 503);
          const { data: testHandover, error: testHandoverError } = await supabase.from("rafa_handovers")
            .select("id,contact_id,department,priority,status,summary").eq("id", handoverId).maybeSingle();
          if (testHandoverError) throw testHandoverError;
          const { data: testContact, error: testContactError } = testHandover
            ? await supabase.from("rafa_contacts").select("whatsapp_jid").eq("id", testHandover.contact_id).maybeSingle()
            : { data: null, error: null };
          if (testContactError) throw testContactError;
          const idempotencyKey = String(body.idempotencyKey || "").trim().slice(0, 240);
          if (!canCreateP65TestNotification({ kind, testRunId, idempotencyKey, handover: testHandover, contact: testContact, recipient })) {
            throw new HttpError("Controlled recipient routing is limited to the matching synthetic P6.5 handover.", 403);
          }
          payload = {
            department: "general",
            priority: "normal",
            intent: "p6_5_controlled_delivery_test",
            name: "REFAL P6.5 test",
            need: "Synthetic internal notification verification. Do not contact a customer.",
            p65TestRunId: testRunId
          };
        } else {
          // Normal production handover notifications remain on the non-deliverable sandbox lane.
          recipient = "sandbox@refalco.test";
        }
        if (!isUuid(handoverId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new HttpError("A handover and valid admin notification address are required.", 400);
        if (!testRunId) payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? boundedObject(body.payload, 4000) : {};
      } else if (kind === "admin_followup") {
        channel = String(body.channel || "");
        recipient = String(body.recipient || "").trim();
        handoverId = String(body.handoverId || "");
        status = String(body.status || "draft");
        const source = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
        const subject = String(source.subject || "").trim().slice(0, 180);
        const text = String(source.text || "").trim().slice(0, 4000);
        if (!isUuid(handoverId) || !["whatsapp", "email"].includes(channel) || status !== "draft" || !text) throw new HttpError("A valid handover follow-up draft is required.", 400);
        if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new HttpError("Enter a valid customer email address.", 400);
        if (channel === "whatsapp" && !validWhatsAppJid(recipient)) throw new HttpError("Choose a valid WhatsApp contact.", 400);
        await requireFollowUpConsent(handoverId);
        payload = channel === "email" ? { subject: subject || "A follow-up from Refalco Group", text } : { text };
      } else throw new HttpError("Unsupported notification type.", 400);
      const appointmentId = body.appointmentId ? String(body.appointmentId) : null;
      if (!idempotencyKey) throw new HttpError("An idempotency key is required.", 400);
      if (kind === "owner_review") {
        if (!appointmentId || !isUuid(appointmentId)) throw new HttpError("A valid appointment ID is required.", 400);
        if (!["pending_review", "pending_calendar", "creating"].includes(expectedStatus)) throw new HttpError("Admin review email must be tied to a pending appointment.", 400);
      }
      if (kind === "admin_followup" || kind === "handover_review") {
        if (!handoverId) throw new HttpError("A valid handover is required.", 400);
      } else if (kind === "customer_message" && (!appointmentId || !isUuid(appointmentId))) {
        throw new HttpError("A valid appointment ID is required.", 400);
      }
      if (appointmentId && !["pending_review", "pending_calendar", "creating", "confirmed", "rejected", "rescheduled", "cancelled"].includes(expectedStatus)) throw new HttpError("A valid expected appointment status is required.", 400);
      const { data, error } = await supabase.from("rafa_notification_jobs").insert({
        appointment_id: appointmentId, handover_id: handoverId, channel, kind, recipient, payload, status,
        expected_appointment_status: expectedStatus || null, idempotency_key: idempotencyKey
      }).select("*").single();
      if (!error) return json({ notification: data, created: true }, 201);
      if (error.code !== "23505") throw error;
      const { data: existing, error: lookupError } = await supabase.from("rafa_notification_jobs").select("*").eq("idempotency_key", idempotencyKey).single();
      if (lookupError) throw lookupError;
      const matches = existing.kind === kind && existing.recipient === recipient && existing.appointment_id === appointmentId && existing.handover_id === handoverId && stableJson(existing.payload) === stableJson(payload);
      if (!matches) throw new HttpError("Notification key is already used for a different message.", 409);
      return json({ notification: existing, created: false });
    }

    if (parts[0] === "notifications" && parts[1] && parts[2] === "send" && req.method === "POST" && parts.length === 3) {
      if (!isUuid(parts[1])) throw new HttpError("Invalid notification ID.", 400);
      const { data: draft, error: draftError } = await supabase.from("rafa_notification_jobs").select("id,handover_id").eq("id", parts[1]).eq("kind", "admin_followup").eq("status", "draft").maybeSingle();
      if (draftError) throw draftError;
      if (!draft) throw new HttpError("This follow-up is not a saved draft.", 409);
      await requireFollowUpConsent(draft.handover_id);
      const { data, error } = await supabase.from("rafa_notification_jobs")
        .update({ status: "queued", attempts: 0, next_attempt_at: new Date().toISOString(), locked_at: null, last_error: null })
        .eq("id", parts[1]).eq("kind", "admin_followup").eq("status", "draft").select("*").maybeSingle();
      if (error) throw error;
      if (!data) throw new HttpError("This follow-up is not a saved draft.", 409);
      await logEvent("handover_followup_approved", { notificationId: data.id, handoverId: data.handover_id, channel: data.channel });
      return json({ notification: data });
    }

    if (parts[0] === "notifications" && parts[1] === "claim" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 25));
      // Repair the gap between the durable handover ledger write and the
      // best-effort notification enqueue. A transient queue outage must not
      // permanently strand an open, sandbox-routed handover.
      try { await reconcileHandoverReviewQueue(); }
      catch (reconcileError) {
        await logEvent("handover_notification_reconcile_error", { message: String(reconcileError instanceof Error ? reconcileError.message : reconcileError).slice(0, 200) });
        throw new HttpError("Notification queue reconciliation is unavailable; no notifications were claimed.", 503);
      }
      const { data, error } = await supabase.rpc("rafa_claim_due_notifications", { p_limit: limit });
      if (error) throw error;
      const notifications = [];
      for (const job of data || []) {
        if (job.kind === "handover_review" && job.handover_id) {
          const { data: handover, error: handoverError } = await supabase.from("rafa_handovers")
            .select("status").eq("id", job.handover_id).maybeSingle();
          if (handoverError) throw new HttpError("Handover status verification is unavailable; no notifications were returned.", 503);
          if (!handover || !canRetryHandoverReview(handover.status)) {
            const { error: cancelError } = await supabase.from("rafa_notification_jobs")
              .update({ status: "cancelled", locked_at: null, last_error: "Handover is closed or unavailable." })
              .eq("id", job.id).eq("status", "processing");
            if (cancelError) throw new HttpError("Closed handover notification could not be cancelled.", 503);
            const closedPatch = ledgerPatchForClosedHandover(handover?.status) || {
              status: "closed", closed_at: new Date().toISOString(), closure_reason: "handover_unavailable",
              next_attempt_at: null, updated_at: new Date().toISOString()
            };
            const { error: closeError } = await supabase.from("refal_handover_delivery")
              .update(closedPatch).eq("handover_id", job.handover_id).neq("status", "closed");
            if (closeError) throw new HttpError("Closed handover delivery could not be reconciled.", 503);
            continue;
          }
        }
        if (job.kind === "admin_followup") {
          try { await requireFollowUpConsent(job.handover_id); }
          catch (consentError) {
            if (consentError instanceof HttpError && consentError.statusCode === 403) {
              await supabase.from("rafa_notification_jobs").update({ status: "cancelled", locked_at: null, last_error: "Follow-up consent missing or revoked." }).eq("id", job.id).eq("status", "processing");
            } else {
              // A transient consent lookup failure delays delivery without
              // discarding a previously approved, still-unverified draft.
              await supabase.from("rafa_notification_jobs").update({ status: "queued", locked_at: null, next_attempt_at: new Date(Date.now() + 60_000).toISOString(), last_error: "Consent lookup temporarily unavailable." }).eq("id", job.id).eq("status", "processing");
            }
            continue;
          }
        }
        notifications.push(job);
      }
      return json({ notifications });
    }

    if (parts[0] === "notifications" && parts[1] && req.method === "PUT" && parts.length === 2) {
      const body = await req.json().catch(() => ({}));
      const patch: Record<string, unknown> = {};
      if (!["sent", "failed", "dead", "cancelled"].includes(String(body.status || ""))) throw new HttpError("Invalid notification result state.", 400);
      patch.status = body.status;
      patch.locked_at = null;
      if (body.status === "sent") {
        patch.sent_at = body.sentAt || new Date().toISOString();
        patch.provider_message_id = String(body.providerMessageId || "").slice(0, 240) || null;
        patch.last_error = null;
      } else {
        patch.last_error = String(body.lastError || "Delivery failed.").replace(/[\r\n\t]/g, " ").slice(0, 800);
        patch.next_attempt_at = body.nextAttemptAt || new Date().toISOString();
      }
      const { data, error } = await supabase.from("rafa_notification_jobs").update(patch).eq("id", parts[1]).eq("status", "processing").select("*").maybeSingle();
      if (error) throw error;
      if (!data) throw new HttpError("Notification job is no longer claimed.", 409);
      if (data.handover_id && data.kind === "handover_review") {
        const now = new Date().toISOString();
        const deliveryPatch = ledgerPatchForNotificationResult(body.status, data.attempts, now, body.nextAttemptAt || now);
        const { error: deliveryError } = await supabase.from("refal_handover_delivery").update(deliveryPatch).eq("handover_id", data.handover_id);
        if (deliveryError) throw deliveryError;
      }
      return json({ notification: data });
    }

    if (parts[0] === "contacts" && parts[1] && parts.length === 2 && req.method === "DELETE") {
      return json({ deleted: await deleteUser(decodeURIComponent(parts[1])) });
    }

    if (parts[0] === "contacts" && parts[1] && parts[2] === "conversation" && req.method === "DELETE") {
      return json(await deleteConversationData(decodeURIComponent(parts[1])));
    }

    if (parts[0] === "controlled-diagnostics" && req.method === "POST") {
      const body = await req.json();
      if (!isUuid(String(body.sourceTurnId || ""))) throw new HttpError("Persisted source turn required.", 400);
      const contact = await getUser(String(body.userId || ""), false);
      if (!contact?.contactId || contact.profile?.qaControlledDiagnostics !== true || contact.profile?.followUpBlocked !== true) {
        throw new HttpError("Contact is not enrolled for controlled diagnostics.", 403);
      }
      const { data: turn, error: turnError } = await supabase.from("rafa_conversation_turns").select("id")
        .eq("id", body.sourceTurnId).eq("contact_id", contact.contactId).maybeSingle();
      if (turnError) throw turnError;
      if (!turn) throw new HttpError("Source turn not found.", 404);
      if (JSON.stringify(body.inspection || {}).length > 100000) throw new HttpError("Inspection exceeds size limit.", 413);
      const inspection = sanitizeControlledInspection(body.inspection, [contact.id, contact.phone, contact.profile?.name]);
      if (!inspection) throw new HttpError("Invalid controlled inspection.", 400);
      const { data, error } = await supabase.from("rafa_events").insert({ event: "agent_controlled_inspection",
        fields: { sourceTurnId: turn.id, contactId: contact.contactId, inspection }, at: new Date().toISOString() }).select("id").single();
      if (error) throw error;
      return json({ inspectionId: data.id });
    }
    if (parts[0] === "controlled-diagnostics" && parts[1] && req.method === "GET") {
      const contact = await getUser(decodeURIComponent(parts[1]), false);
      if (!contact?.contactId || contact.profile?.qaControlledDiagnostics !== true) throw new HttpError("Controlled diagnostics unavailable.", 404);
      const { data, error } = await supabase.from("rafa_events").select("id,at,fields")
        .eq("event", "agent_controlled_inspection").contains("fields", { contactId: contact.contactId }).order("at", { ascending: true }).limit(100);
      if (error) throw error;
      return json({ inspections: (data || []).map((row) => ({ id: row.id, at: row.at, sourceTurnId: row.fields.sourceTurnId,
        inspection: sanitizeControlledInspection(row.fields.inspection, [contact.id, contact.phone, contact.profile?.name]) })) });
    }
    if (parts[0] === "events" && req.method === "POST") {
      const body = await req.json();
      const event = String(body.event || "unknown").trim();
      const fields = body.fields ?? {};
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(event)) throw new HttpError("Invalid event name.", 400);
      if (event === "agent_controlled_inspection") throw new HttpError("Use controlled diagnostics endpoint.", 400);
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || JSON.stringify(fields).length > 8192) {
        throw new HttpError("Event fields must be an object no larger than 8 KB.", 413);
      }
      await logEvent(event, fields);
      return json({ ok: true });
    }

    if (parts[0] === "events" && req.method === "GET") {
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") || 1000)));
      return json({ events: await listEvents(limit) });
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const requestId = crypto.randomUUID();
    console.error("rafa-agent-api request failed", { requestId, status, error });
    const message = status < 500 && (error instanceof HttpError || (error && typeof error === "object" && (error as Error).name === "HttpError")) ? (error as Error).message : "RAFA API request failed.";
    return json({ error: message, requestId }, status);
  }
});

async function listUsers(includeHistory: boolean) {
  const { data, error } = await supabase
    .from("rafa_contacts")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;

  const rows = data || [];
  const crmByContact = new Map<string, Record<string, unknown>>();
  if (rows.length) {
    for (let offset = 0; offset < rows.length; offset += 500) {
      const ids = rows.slice(offset, offset + 500).map((row) => row.id);
      const { data: crmRows, error: crmError } = await supabase.from("refal_lead_profile")
        .select("contact_id,identity_fields,opportunity_fields,property_residency_fields,qualification_fields,field_provenance,crm_correction_needed")
        .in("contact_id", ids);
      if (crmError) throw crmError;
      for (const crmRow of crmRows || []) crmByContact.set(crmRow.contact_id, crmRow);
    }
  }
  const users = await Promise.all(rows.map(async (row) => {
    const user = await attachWorkflowState(rowToUser(row, []));
    return attachCrmProfile(user, crmByContact.get(row.id) || null);
  }));
  if (!includeHistory) return users;
  if (!users.length) return users;

  const historyByUserId = new Map<string, Record<string, unknown>[]>();
  const userIdBatches: string[][] = [];
  for (let index = 0; index < users.length; index += 100) {
    userIdBatches.push(users.slice(index, index + 100).map((user) => user.id));
  }

  await Promise.all(userIdBatches.map(async (userIds) => {
    let offset = 0;
    while (true) {
      const { data: turns, error: historyError } = await supabase
        .from("rafa_conversation_turns")
        .select("id,user_id,at,message,response,automated,source,metadata")
        .in("user_id", userIds)
        .order("user_id", { ascending: true })
        .order("at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (historyError) throw historyError;

      for (const turn of turns || []) {
        const history = historyByUserId.get(turn.user_id) || [];
        history.push({
          id: turn.id,
          at: turn.at,
          message: turn.message,
          response: turn.response,
          automated: turn.automated,
          source: turn.source,
          metadata: turn.metadata
        });
        historyByUserId.set(turn.user_id, history);
      }

      if ((turns || []).length < 1000) break;
      offset += 1000;
    }
  }));

  return users.map((user) => ({ ...user, history: historyByUserId.get(user.id) || [] }));
}

async function listAgentSessions() {
  const { data, error } = await supabase
    .from("rafa_agent_sessions")
    .select("id,title,model,memory_enabled,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  return data || [];
}

async function generateAgentReply(body: Record<string, any>) {
  const responseStyle = await loadResponseStyle();
  const companyIdentity = await loadCompanyIdentity();
  const businessGuidance = await loadBusinessGuidance();
  let apiKey: string;
  try { apiKey = await loadProviderSecret(); }
  catch { throw new HttpError("OpenRouter is not configured in Supabase secrets or Vault.", 503); }

  const text = redactForModel(String(body.text || "").trim()).slice(0, 4000);
  if (!text) throw new HttpError("Message text is required.", 400);
  const language = detectMessageLanguage(text);

  const model = resolveChatModel(body.model || Deno.env.get("OPENROUTER_MODEL"));
  // Caller-provided evidence is only a list of requested chunk IDs. Rebuild
  // content, revision approval, expiry, active-source state, and explicit fact
  // blocks from the DB so a valid API caller cannot forge evidence or policy
  // metadata in this payload.
  let evidence: Record<string, any>[];
  try {
    evidence = await resolveTrustedKnowledgeEvidence(supabase, body.evidence);
  } catch {
    // A failed authoritative read must never fall back to caller-supplied text.
    throw new HttpError("Approved knowledge could not be verified. Please retry shortly.", 503);
  }
  const memories = Array.isArray(body.memories) ? body.memories.slice(0, 8) : [];
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const payload = {
    model,
    provider: { data_collection: "deny", zdr: true },
    usage: { include: true },
    max_tokens: 650,
    ...(model === defaultChatModel ? { reasoning: { effort: "none", exclude: true } } : { temperature: 0.35 }),
    messages: [
      {
        role: "system",
        content: [
          // W1.7.4 — the shared prompt blocks, identical to the ones src/ai.js
          // and dashboard/server.js build from. This used to be a third
          // hand-maintained copy of the same rules; that is where BLK-3, BLK-5
          // and BLK-6 each survived on one surface after being fixed on the
          // others. brainPrompt.mjs is GENERATED from src/brainPrompt.js by
          // scripts/generateEdgeBrainPrompt.js and drift-tested, so this
          // surface can no longer fall behind.
          // No leadTier, for the same reason as dashboard/server.js: this is
          // the operator surface, answering a free-form operator question with
          // no single customer conversation in scope. An earlier version read
          // `body.lead_tier`, which no caller has ever sent — dead wiring that
          // reads as if the tier were plumbed through when it is not. The
          // builder's default emits the protective instruction.
          ...buildOperatorPrompt({ variant: "operator", responseStyle, companyIdentity }),
          responseStyleInstruction(responseStyle),
          businessGuidanceInstruction(businessGuidance, language),
          languageInstruction(language),
          // Edge-specific operator instructions. These are NOT policy rules and
          // have no counterpart on the customer path: they describe this
          // surface's job (dashboard operations) and its data access.
          "Apply the REFAL operating order: understand, help, discover, qualify, build trust, capture, convert, book, handover, follow up.",
          "Be concise, practical, calm, and direct. Answer first when possible; ask only one useful next question and do not over-qualify a clear opportunity.",
          "Qualification tiers are internal: Informational 0-7, Cold 8-13, Warm 14-19, Hot 20-24, Strategic 25-30. At Informational/Cold, do not push booking. Warm permits a flexible, non-repeated appointment offer. At Hot/Strategic, suppress every cross-sell hook and benefit hint and focus on logistics. Contact requests, follow-up, and booking still require the customer's explicit request or consent; never imply an appointment is confirmed unless the booking system confirms it. Never expose scores, dimensions, or tier labels.",
          // Deliberately states the personality WITHOUT inviting humour. The
          // customer path calibrates humour to a level and enforces it with
          // assertHumourCompliance; this surface has neither, so an
          // uncalibrated "light humor when it fits" would be an instruction
          // with nothing behind it — worse than saying nothing about humour.
          "REFAL's personality is cheerful, warm, positive, quick-witted, simple, natural, and commercially perceptive. Express this same personality naturally in Arabic, English, and Greek; adapt idiom to each language instead of translating catchphrases literally. Stay sober and plain in complaints, legal or tax concerns, financial loss, health matters, sanctions and AML.",
          "Use saved memory when relevant, but do not claim live access to WhatsApp unless data is provided.",
          "If the operator asks a general-knowledge question unrelated to Refalco Group or dashboard operations, briefly redirect to Refalco Group; do not answer from general knowledge.",
          "Do not mention internal source names, owner confirmations, review status, or verification steps. Include source links only when the customer asks for provenance or a citation is needed to explain material uncertainty.",
          "Retrieved approved company knowledge:",
          evidence.length ? evidence.map((item: Record<string, any>, index: number) => `[${index + 1}] ${redactForModel(String(item.source_name || "Source")).slice(0, 120)} (${String(item.source_url || "").slice(0, 500)})\n${redactForModel(String(item.heading || "")).slice(0, 200)}\n${redactForModel(String(item.content || "")).slice(0, 1800)}`).join("\n\n") : "No approved company knowledge retrieved.",
          "",
          "Saved RAFA memory:",
          memories.length ? memories.map((memory: Record<string, any>) => `- ${redactForModel(String(memory.label || "Memory")).slice(0, 80)}: ${redactForModel(String(memory.content || "")).slice(0, 600)}`).join("\n") : "No saved memories yet."
        ].join("\n")
      },
      ...messages.map((message: Record<string, any>) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: redactForModel(String(message.content || "")).slice(0, 4000)
      })),
      { role: "user", content: text }
    ]
  };
  if (!isPromptWithinTokenCeiling(payload)) {
    throw new HttpError("The model prompt exceeds the configured input limit. Shorten the conversation and retry.", 413);
  }

  let response: Response;
  let result: Record<string, any>;
  const providerStartedAt = performance.now();
  try {
    ({ response, body: result } = await fetchJsonWithTimeout(openRouterUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://anhharmjtmqndhzenicb.supabase.co",
        "X-OpenRouter-Title": "RAFA Dashboard"
      },
      body: JSON.stringify(payload)
    }));
  } catch (error) {
    if (error instanceof ProviderTimeoutError || (error && typeof error === "object" && (error as Error).name === "ProviderTimeoutError")) {
      throw new HttpError("AI provider timed out. Please retry shortly.", 503);
    }
    throw new HttpError("AI provider is temporarily unavailable. Please retry shortly.", 503);
  }
  if (!response.ok || result?.error) {
    throw new HttpError(result?.error?.message || `OpenRouter HTTP ${response.status}`, response.status >= 400 && response.status < 500 ? 502 : response.status);
  }
  const reply = String(result?.choices?.[0]?.message?.content || "").trim();
  if (!reply) throw new HttpError("OpenRouter returned an empty answer.", 502);
  if (reply.length > 8 && detectMessageLanguage(reply) !== language) throw new HttpError("The model returned an answer in the wrong customer language.", 502);
  // P2.2 — the gate gets the SAME approved evidence the model was grounded on.
  // Passing none made this surface strictly stricter than src/refalcoAnswer.js,
  // which is the same class of divergence the generated mirrors exist to end:
  // a programme fact quoted straight out of an approved chunk was deleted here
  // and allowed there. Unapproved and expired chunks are filtered by
  // isApprovedEvidence inside the gate, so this can only ever unlock a fact the
  // evidence actually carries.
  if (reply.length > 10000 || containsProhibitedClaim(reply, { evidence }) || containsSensitiveOutputValue(reply) || containsForbiddenCredentialRequest(reply) || containsUnconsentedContactCommitment(reply) || containsProhibitedConstructionEstimate(text, reply)) throw new HttpError("The model returned an unsafe or invalid answer.", 502);
  return {
    reply: reply.slice(0, 10000),
    usage: normalizeOpenRouterUsage(result, model, Math.max(0, Math.round(performance.now() - providerStartedAt)))
  };
}

function redactForModel(value: string) {
  return String(value || "")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, "[redacted-phone]")
    .replace(/\b(?:iban|account|card|passport|identity|id|tax)\s*[:#-]?\s*[A-Z0-9 -]{5,}\b/gi, "[redacted-sensitive-id]")
    .replace(/\b(?:password|pin|token|api[_ -]?key|secret)\s*[:=]\s*\S+/gi, "[redacted-secret]");
}


async function createAgentSession(body: Record<string, unknown>) {
  const model = resolveChatModel(body.model || Deno.env.get("OPENROUTER_MODEL"));
  const { data, error } = await supabase
    .from("rafa_agent_sessions")
    .insert({
      title: cleanTitle(String(body.title || "New chat")),
      model,
      memory_enabled: body.memoryEnabled !== false
    })
    .select("id,title,model,memory_enabled,created_at,updated_at")
    .single();
  if (error) throw error;
  return data;
}

async function getAgentSession(sessionId: string) {
  const { data: session, error: sessionError } = await supabase
    .from("rafa_agent_sessions")
    .select("id,title,model,memory_enabled,created_at,updated_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return { session: null, messages: [] };

  const { data: messages, error: messageError } = await supabase
    .from("rafa_agent_messages")
    .select("id,session_id,role,content,metadata,created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (messageError) throw messageError;

  return { session, messages: messages || [] };
}

async function updateAgentSession(sessionId: string, body: Record<string, unknown>) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) patch.title = cleanTitle(String(body.title || "New chat"));
  if (body.model !== undefined) patch.model = resolveChatModel(body.model);
  if (body.memoryEnabled !== undefined) patch.memory_enabled = body.memoryEnabled !== false;

  const { data, error } = await supabase
    .from("rafa_agent_sessions")
    .update(patch)
    .eq("id", sessionId)
    .select("id,title,model,memory_enabled,created_at,updated_at")
    .single();
  if (error) throw error;
  return data;
}

async function deleteAgentSession(sessionId: string) {
  const { count, error } = await supabase
    .from("rafa_agent_sessions")
    .delete({ count: "exact" })
    .eq("id", sessionId);
  if (error) throw error;
  return Boolean(count);
}

async function addAgentMessage(sessionId: string, body: Record<string, unknown>) {
  const role = String(body.role || "user");
  if (!["user", "assistant", "system"].includes(role)) throw new Error("Invalid message role.");

  const content = String(body.content || "").trim();
  if (!content) throw new Error("Message content is required.");

  const { data, error } = await supabase
    .from("rafa_agent_messages")
    .insert({
      session_id: sessionId,
      role,
      content,
      metadata: body.metadata || {},
      created_at: body.createdAt || new Date().toISOString()
    })
    .select("id,session_id,role,content,metadata,created_at")
    .single();
  if (error) throw error;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (role === "user" && body.title) patch.title = cleanTitle(String(body.title));
  await supabase.from("rafa_agent_sessions").update(patch).eq("id", sessionId);

  return data;
}

async function loadResponseStyle() {
  try {
    const { data, error } = await supabase.from("rafa_settings").select("value").eq("key", "response_style").maybeSingle();
    if (error) throw error;
    return validateResponseStyle(data?.value || RESPONSE_STYLE_DEFAULTS);
  } catch {
    // A presentation preference outage must not stop a dashboard answer.
    return RESPONSE_STYLE_DEFAULTS;
  }
}

async function loadCompanyIdentity() {
  try {
    const { data, error } = await supabase.from("rafa_settings").select("value").eq("key", "company_identity").maybeSingle();
    if (error) throw error;
    return validateCompanyIdentity(data?.value || DEFAULT_COMPANY_IDENTITY);
  } catch {
    // Keep the validated startup identity as the safe fallback during a settings outage.
    return DEFAULT_COMPANY_IDENTITY;
  }
}

async function loadBusinessGuidance() {
  try {
    const { data, error } = await supabase.from("rafa_settings").select("value").eq("key", "business_guidance").maybeSingle();
    if (error) throw error;
    return validateBusinessGuidance(data?.value || BUSINESS_GUIDANCE_DEFAULTS);
  } catch {
    return BUSINESS_GUIDANCE_DEFAULTS;
  }
}

async function listAgentMemories() {
  const { data, error } = await supabase
    .from("rafa_agent_memories")
    .select("id,label,content,source_session_id,pinned,created_at,updated_at")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(80);
  if (error) throw error;
  return data || [];
}

async function createAgentMemory(body: Record<string, unknown>) {
  const content = String(body.content || "").trim();
  if (!content) throw new Error("Memory content is required.");

  const { data, error } = await supabase
    .from("rafa_agent_memories")
    .insert({
      label: cleanTitle(String(body.label || "Memory")),
      content,
      source_session_id: body.sourceSessionId || null,
      pinned: Boolean(body.pinned)
    })
    .select("id,label,content,source_session_id,pinned,created_at,updated_at")
    .single();
  if (error) throw error;
  return data;
}

async function deleteAgentMemory(memoryId: string) {
  const { count, error } = await supabase
    .from("rafa_agent_memories")
    .delete({ count: "exact" })
    .eq("id", memoryId);
  if (error) throw error;
  return Boolean(count);
}

async function getUser(userId: string, includeHistory = true): Promise<Record<string, any> | null> {
  const { data, error } = await supabase
    .from("rafa_contacts")
    .select("*")
    .eq("whatsapp_jid", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const user = await attachCrmProfile(await attachWorkflowState(rowToUser(data, [])));
  return includeHistory ? attachHistory(user) : user;
}

async function ensureUser(userId: string): Promise<Record<string, any>> {
  if (!userId) throw new Error("Missing userId.");

  const existing = await getUser(userId, true);
  if (existing) return existing;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("rafa_contacts")
    .insert({
      whatsapp_jid: userId,
      phone: userId.replace(/@.+$/, ""),
      profile: {},
      step: "name",
      whatsapp: {},
      created_at: now,
      updated_at: now
    })
    .select("*")
    .single();
  if (error) throw error;
  return attachCrmProfile(await attachWorkflowState(rowToUser(data, [])));
}

async function updateUser(userId: string, body: Record<string, unknown>) {
  await ensureUser(userId);
  const { data, error } = await supabase
    .from("rafa_contacts")
    .update({
      phone: String(body.phone || userId.replace(/@.+$/, "")),
      profile: body.profile || {},
      step: body.step || null,
      whatsapp: body.whatsapp || {},
      booking: body.booking || null,
      last_follow_up_sent: body.lastFollowUpSent || null
    })
    .eq("whatsapp_jid", userId)
    .select("*")
    .single();
  if (error) throw error;
  return attachHistory(await attachCrmProfile(rowToUser(data, [])));
}

async function addHistory(user: Record<string, any>, body: Record<string, unknown>) {
  const { data, error } = await supabase
    .from("rafa_conversation_turns")
    .insert(buildSafeHistoryInsert(user, body))
    .select("id,at,message,response,automated,source,metadata")
    .single();
  if (error) throw error;
  return data;
}

async function updateHistoryTurn(userId: string, turnId: string, body: Record<string, unknown>) {
  if (!userId || userId.length > 200 || userId.trim() !== userId || /[\\/\u0000-\u001f\u007f]/.test(userId)) {
    throw new HttpError("Invalid conversation user ID.", 400);
  }
  if (!isUuid(turnId)) throw new HttpError("Invalid conversation turn ID.", 400);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError("A valid update is required.", 400);
  const allowedFields = new Set(["response", "metadata"]);
  if (Object.keys(body).some((key) => !allowedFields.has(key)) || !Object.hasOwn(body, "response")) {
    throw new HttpError("Only response and safe metadata updates are allowed.", 400);
  }

  if (typeof body.response !== "string") throw new HttpError("Response must be text.", 400);
  const response = body.response.trim();
  if (!response || response.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(response)) {
    throw new HttpError("Response must contain 1 to 10000 valid characters.", 400);
  }

  const metadataPatch = validateHistoryMetadataPatch(body.metadata, userId);
  const { data: current, error: lookupError } = await supabase
    .from("rafa_conversation_turns")
    .select("metadata")
    .eq("id", turnId)
    .eq("user_id", userId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!current) throw new HttpError("Conversation turn not found.", 404);

  const metadata = { ...(current.metadata || {}) };
  for (const [key, value] of Object.entries(metadataPatch)) {
    metadata[key] = { ...(metadata[key] || {}), ...value };
  }

  const { data, error } = await supabase
    .from("rafa_conversation_turns")
    .update({ response, metadata })
    .eq("id", turnId)
    .eq("user_id", userId)
    .select("id,at,message,response,automated,source,metadata")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError("Conversation turn not found.", 404);
  return data;
}

function validateHistoryMetadataPatch(value: unknown, userId: string) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError("Metadata must be an object.", 400);
  const patch = value as Record<string, unknown>;
  const allowedSections = new Set(["delivery", "editability", "whatsapp", "salesOffer", "specialistOffer", "followUpConsent"]);
  if (Object.keys(patch).some((key) => !allowedSections.has(key))) throw new HttpError("Unsupported history metadata section.", 400);

  const deliveryFields: Record<string, (value: unknown) => boolean> = {
    action: (item) => typeof item === "string" && ["platform_edit", "correction_resend"].includes(item),
    status: (item) => typeof item === "string" && ["pending", "sent", "delivered", "failed"].includes(item),
    message: (item) => typeof item === "string" && item.length <= 500,
    canEditOnWhatsApp: (item) => typeof item === "boolean",
    edited: (item) => typeof item === "boolean",
    resent: (item) => typeof item === "boolean"
  };
  const editabilityFields: Record<string, (value: unknown) => boolean> = {
    canEditOnWhatsApp: (item) => typeof item === "boolean"
  };
  const whatsappFields: Record<string, (value: unknown) => boolean> = {
    sentAt: (item) => typeof item === "string" && Number.isFinite(Date.parse(item)),
    messageKey: (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const key = item as Record<string, unknown>;
      const stringKeyFields = new Set(["participant", "remoteJidAlt", "remoteJidUsername", "participantAlt", "participantUsername"]);
      const allowedKeyFields = new Set(["id", "remoteJid", "fromMe", ...stringKeyFields, "server_id", "addressingMode", "isViewOnce"]);
      const optionalFieldsValid = Object.entries(key).every(([field, fieldValue]) => {
        if (stringKeyFields.has(field)) return typeof fieldValue === "string" && fieldValue.length <= 200;
        if (field === "server_id") return typeof fieldValue === "string" && fieldValue.length <= 256;
        if (field === "addressingMode") return fieldValue === "pn" || fieldValue === "lid";
        if (field === "isViewOnce") return typeof fieldValue === "boolean";
        return allowedKeyFields.has(field);
      });
      return optionalFieldsValid && key.fromMe === true &&
        typeof key.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(key.id) &&
        key.remoteJid === userId && /^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(userId) &&
        (key.participant === undefined || key.participant === null || (typeof key.participant === "string" && key.participant.length <= 200));
    }
  };
  const result: Record<string, Record<string, unknown>> = {};
  for (const [section, fields] of Object.entries(patch)) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new HttpError(`Metadata ${section} must be an object.`, 400);
    if (section === "salesOffer") {
      const validated = validateSalesOfferMetadata(fields);
      if (!validated) throw new HttpError("Invalid sales offer metadata.", 400);
      result[section] = validated;
      continue;
    }
    if (section === "specialistOffer") {
      const validated = validateSpecialistOfferMetadata(fields);
      if (!validated) throw new HttpError("Invalid specialist offer metadata.", 400);
      result[section] = validated;
      continue;
    }
    const input = fields as Record<string, unknown>;
    if (section === "followUpConsent") {
      const stateValid = ["unknown", "granted", "denied", "revoked"].includes(String(input.state || ""));
      const valid = stateValid && input.purpose === "automated_reminder" && input.channel === "whatsapp" &&
        ["ar", "en", "el"].includes(String(input.language || "")) && isUuid(String(input.sourceTurnId || "")) &&
        (input.offerSourceTurnId === null || isUuid(String(input.offerSourceTurnId || "")));
      if (!valid || (input.state === "granted" && !isUuid(String(input.offerSourceTurnId || "")))) throw new HttpError("Invalid automated reminder consent metadata.", 400);
      result[section] = input;
      continue;
    }
    const validators = section === "delivery" ? deliveryFields : section === "editability" ? editabilityFields : whatsappFields;
    if (Object.keys(input).some((key) => !validators[key])) throw new HttpError(`Unsupported ${section} metadata field.`, 400);
    for (const [key, item] of Object.entries(input)) {
      if (!validators[key](item)) throw new HttpError(`Invalid ${section}.${key} value.`, 400);
    }
    result[section] = input;
  }
  return result;
}

async function createAppointment(body: Record<string, any>) {
  const userId = String(body.userId || "").trim();
  const idempotencyKey = String(body.idempotencyKey || "").trim();
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  const durationMinutes = Number(body.durationMinutes);
  const purpose = String(body.purpose || "").trim();
  const calendarId = String(body.calendarId || "").trim();
  const timezone = String(body.timezone || "").trim();
  const requestedStatus = String(body.status || "pending_review");
  if (!userId || userId.length > 200 || !idempotencyKey || idempotencyKey.length > 200) throw new HttpError("A user and valid idempotency key are required.", 400);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new HttpError("A valid appointment start and end are required.", 400);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240 || Math.abs((endsAt.getTime() - startsAt.getTime()) / 60000 - durationMinutes) > 0.01) throw new HttpError("Appointment duration does not match its start and end.", 400);
  if (!purpose || purpose.length > 1000 || !calendarId || calendarId.length > 320 || !timezone || timezone.length > 80) throw new HttpError("Purpose, calendar, and timezone are required.", 400);
  if (!["pending_review", "awaiting_customer_confirmation"].includes(requestedStatus)) throw new HttpError("Invalid initial appointment status.", 400);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new HttpError("Invalid appointment timezone.", 400); }

  const contact = await ensureUser(userId);
  const values = {
    contact_id: contact.contactId,
    whatsapp_jid: userId,
    status: requestedStatus,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    timezone,
    duration_minutes: durationMinutes,
    purpose,
    idempotency_key: idempotencyKey,
    calendar_id: calendarId,
    metadata: boundedObject(body.metadata, 6000)
  };
  const { data, error } = await supabase.from("rafa_appointments").insert(values).select("*").single();
  if (!error) return { ...data, created: true };
  if (error.code !== "23505") throw error;

  const { data: existing, error: lookupError } = await supabase.from("rafa_appointments")
    .select("*").eq("idempotency_key", idempotencyKey).single();
  if (lookupError) throw lookupError;
  const sameIntent = existing.whatsapp_jid === userId &&
    Date.parse(existing.starts_at) === startsAt.getTime() &&
    Date.parse(existing.ends_at) === endsAt.getTime() &&
    existing.purpose === purpose && existing.calendar_id === calendarId;
  if (!sameIntent) return { conflict: true };
  return { ...existing, created: false };
}

async function updateAppointment(appointmentId: string, body: Record<string, any>) {
  if (!isUuid(appointmentId)) throw new HttpError("Invalid appointment ID.", 400);
  const { data: current, error: currentError } = await supabase.from("rafa_appointments")
    .select("id,status,metadata").eq("id", appointmentId).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new HttpError("Appointment not found.", 404);

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) {
    const next = String(body.status);
    if (!isAllowedAppointmentTransition(current.status, next)) {
      const message = next === current.status && next === "creating"
        ? "This appointment is already being created."
        : `Invalid appointment status transition: ${current.status} to ${next}.`;
      throw new HttpError(message, 409);
    }
    patch.status = next;
    if (next === "confirmed") patch.confirmed_at = body.confirmedAt || new Date().toISOString();
    if (next === "cancelled") patch.cancelled_at = body.cancelledAt || new Date().toISOString();
    if (next === "pending_review") {
      patch.reviewed_at = null;
      patch.reviewed_by = null;
      patch.review_reason = null;
    }
  }
  if (body.googleEventId !== undefined) patch.google_event_id = String(body.googleEventId || "").slice(0, 1024) || null;
  if (body.googleEventUrl !== undefined) {
    const value = String(body.googleEventUrl || "").trim();
    if (value) {
      const eventUrl = new URL(value);
      if (eventUrl.protocol !== "https:" || eventUrl.hostname !== "calendar.google.com") throw new HttpError("Invalid Google Calendar event URL.", 400);
    }
    patch.google_event_url = value.slice(0, 2048) || null;
  }
  if (body.googleMeetUrl !== undefined) {
    const value = String(body.googleMeetUrl || "").trim();
    if (value) {
      const meetUrl = new URL(value);
      if (meetUrl.protocol !== "https:" || meetUrl.hostname !== "meet.google.com") throw new HttpError("Invalid Google Meet URL.", 400);
    }
    patch.google_meet_url = value.slice(0, 2048) || null;
  }
  if (body.reviewedAt !== undefined) patch.reviewed_at = body.reviewedAt ? new Date(body.reviewedAt).toISOString() : null;
  if (body.reviewedBy !== undefined) patch.reviewed_by = String(body.reviewedBy || "").trim().slice(0, 200) || null;
  if (body.reviewReason !== undefined) {
    const reason = String(body.reviewReason || "").trim();
    if (reason.length > 500) throw new HttpError("Review reason is too long.", 400);
    patch.review_reason = reason || null;
  }
  if (body.metadata !== undefined) {
    if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) throw new HttpError("Appointment metadata must be an object.", 400);
    patch.metadata = boundedObject({ ...(current.metadata || {}), ...body.metadata }, 6000);
  }
  if (!hasConfirmationEventId(body.status, body.googleEventId)) throw new HttpError("A Google Calendar event ID is required before confirmation.", 400);
  if (!Object.keys(patch).length) throw new HttpError("No supported appointment changes were supplied.", 400);
  let { data, error } = await updateAppointmentIfStatusMatches(supabase, appointmentId, current.status, patch);
  if (error && "google_meet_url" in patch && /google_meet_url/i.test(error.message || "")) {
    delete patch.google_meet_url;
    ({ data, error } = await updateAppointmentIfStatusMatches(supabase, appointmentId, current.status, patch));
  }
  if (error?.code === "PGRST116") throw new HttpError("Appointment changed while this action was being processed; refresh and try again.", 409);
  if (error) throw error;
  if (patch.status === "cancelled" || patch.status === "rescheduled") {
    const { error: remindersError } = await supabase.from("rafa_reminder_jobs")
      .update({ status: "cancelled" }).eq("appointment_id", appointmentId).in("status", ["queued", "failed"]);
    if (remindersError) throw remindersError;
  }
  return data;
}

async function createReminder(appointmentId: string, body: Record<string, any>) {
  if (!isUuid(appointmentId)) throw new HttpError("Invalid appointment ID.", 400);
  const { data: appointment, error: appointmentError } = await supabase.from("rafa_appointments")
    .select("id,status").eq("id", appointmentId).maybeSingle();
  if (appointmentError) throw appointmentError;
  if (!appointment) throw new HttpError("Appointment not found.", 404);
  if (appointment.status !== "confirmed") throw new HttpError("Reminders can only be scheduled for confirmed appointments.", 409);

  const dueAt = new Date(body.dueAt);
  const reminder = {
    appointment_id: appointmentId,
    reminder_kind: String(body.kind || "").trim(),
    channel: String(body.channel || "").trim(),
    recipient: String(body.recipient || "").trim(),
    due_at: Number.isFinite(dueAt.getTime()) ? dueAt.toISOString() : "",
    next_attempt_at: Number.isFinite(dueAt.getTime()) ? dueAt.toISOString() : "",
    idempotency_key: String(body.idempotencyKey || "").trim(),
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {}
  };
  if (!reminder.reminder_kind || !reminder.channel || !reminder.recipient || !reminder.due_at || !reminder.idempotency_key || reminder.idempotency_key.length > 240) throw new HttpError("Reminder kind, channel, recipient, due time, and idempotency key are required.", 400);
  if (dueAt <= new Date()) throw new HttpError("Reminder due time must be in the future.", 400);
  const { data, error } = await supabase.from("rafa_reminder_jobs").insert(reminder).select("*").single();
  if (!error) return { ...data, created: true };
  if (error.code !== "23505") throw error;
  const { data: existing, error: lookupError } = await supabase.from("rafa_reminder_jobs")
    .select("*").eq("idempotency_key", reminder.idempotency_key).single();
  if (lookupError) throw lookupError;
  if (existing.appointment_id !== appointmentId) return { conflict: true };
  return { ...existing, created: false };
}

async function updateReminder(reminderId: string, body: Record<string, any>) {
  if (!isUuid(reminderId)) throw new HttpError("Invalid reminder ID.", 400);
  const { data: current, error: currentError } = await supabase.from("rafa_reminder_jobs")
    .select("id,status").eq("id", reminderId).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new HttpError("Reminder not found.", 404);
  const next = String(body.status || "");
  if (!(["sending", "sent", "failed", "dead", "uncertain", "cancelled"].includes(next))) throw new HttpError("Invalid reminder status.", 400);
  if (!isAllowedReminderTransition(current.status, next)) throw new HttpError(`Invalid reminder status transition: ${current.status} to ${next}.`, 409);
  let patch: Record<string, unknown>;
  try { patch = reminderPatchForState(next, body); }
  catch (error) { throw new HttpError(error instanceof Error ? error.message : "Invalid reminder state.", 400); }
  const { data, error } = await supabase.from("rafa_reminder_jobs").update(patch)
    .eq("id", reminderId).eq("status", current.status).select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError("Reminder claim expired or was already processed.", 409);
  return data;
}

async function deleteUser(userId: string) {
  const { count, error } = await supabase
    .from("rafa_contacts")
    .delete({ count: "exact" })
    .eq("whatsapp_jid", userId);
  if (error) throw error;
  return Boolean(count);
}

async function deleteConversationData(userId: string) {
  if (!validWhatsAppJid(userId)) throw new HttpError("A valid WhatsApp contact is required.", 400);
  const { data, error } = await supabase.rpc("refal_reset_conversation_context", { p_whatsapp_jid: userId });
  if (["55006", "55P03"].includes(error?.code || "")) throw new HttpError("A message or follow-up is still being processed. Retry when it finishes.", 409);
  if (error) throw error;
  return { deleted: data?.deleted === true, deletedTurns: Number(data?.deletedTurns) || 0 };
}

const WORKFLOW_INTENTS = new Set(["real_estate", "development", "construction", "land", "investment", "partnership", "corporate_services", "customer_service", "appointment", "complaint", "existing_client", "prompt_injection", "unknown", "company_formation", "accounting", "vat", "cyprus_business_expansion", "business_relocation", "residency_enquiry", "real_estate_purchase", "real_estate_investment", "land_owner", "property_development", "construction_tender", "project_management", "investment_opportunity", "investment_partnership", "strategic_partnership", "infrastructure", "technology", "operations", "strategic_assets", "business_proposal", "supplier", "career", "media", "general_information", "company_info", "services", "contact", "legal", "tax", "immigration", "banking", "permit", "approval", "privacy", "unrelated", "greeting", "small_talk", "agent_identity", "language_capability", "business_areas", "project_enquiry", "land_development", "pricing"]);
const WORKFLOW_DEPARTMENTS = new Set(["customer_service", "corporate_services", "tax", "residency", "real_estate", "development_construction", "investment", "partnerships", "complaints", "existing_client", "appointments", "general"]);
const WORKFLOW_TRIGGERS = new Set(["major_development", "institutional_investment", "strategic_partnership", "complaint", "severe_complaint", "existing_client", "safety_or_threat", "material_business_opportunity"]);

async function runDynamicAction(name: string, body: Record<string, any>) {
  const userId = String(body.userId || "");
  const sourceTurnId = String(body.sourceTurnId || "");
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
  const contact = body.contact;
  if (!contact?.contactId || !sourceTurnId) throw new HttpError("A verified source turn is required.", 400);

  if (name === "upsertLead") {
    const input = args.profile && typeof args.profile === "object" && !Array.isArray(args.profile) ? args.profile
      : args.fields && typeof args.fields === "object" && !Array.isArray(args.fields) ? args.fields : args;
    const allowed = new Set(["name", "nationality", "residenceCountry", "primaryGoal", "budgetAmount", "budgetCurrency"]);
    const profile: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key)) throw new HttpError(`Unsupported lead field: ${key}`, 400);
      if (typeof value === "string") {
        const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
        if (!clean || clean.length > 300) throw new HttpError(`Invalid lead field: ${key}`, 400);
        profile[key] = clean;
      } else if (typeof value === "number" && Number.isFinite(value) && value >= 0 && key === "budgetAmount") profile[key] = value;
      else throw new HttpError(`Invalid lead field: ${key}`, 400);
    }
    if (!Object.keys(profile).length) throw new HttpError("At least one supported lead field is required.", 400);
    const { data: sourceTurn, error: sourceTurnError } = await supabase.from("rafa_conversation_turns")
      .select("message").eq("id", sourceTurnId).eq("contact_id", contact.contactId).maybeSingle();
    if (sourceTurnError) throw sourceTurnError;
    if (!sourceTurn || !validateCustomerLeadFields(profile, sourceTurn.message)) {
      throw new HttpError("Lead details must be stated by the customer in the linked source turn.", 400);
    }
    const { data: current, error: readError } = await supabase.from("refal_lead_profile").select("profile,field_provenance").eq("contact_id", contact.contactId).maybeSingle();
    if (readError) throw readError;
    const capturedAt = new Date().toISOString();
    const provenance = { ...(current?.field_provenance || {}) };
    for (const field of Object.keys(profile)) provenance[field] = { source: "customer_message", source_turn_id: sourceTurnId, captured_at: capturedAt };
    const { data, error } = await supabase.from("refal_lead_profile").upsert({
      contact_id: contact.contactId,
      profile: { ...(current?.profile || {}), ...profile },
      field_provenance: provenance,
      source_turn_id: sourceTurnId
    }, { onConflict: "contact_id" }).select("contact_id,profile,field_provenance,source_turn_id,updated_at").single();
    if (error) throw error;
    if (!data?.contact_id) throw new Error("Lead profile persistence was not confirmed.");
    return { id: data.contact_id, status: "confirmed", userSafeSummary: "Your details were saved." };
  }

  if (name === "createHandover") {
    const department = String(args.department || "general");
    const priority = String(args.priority || "normal");
    if (!WORKFLOW_DEPARTMENTS.has(department) || !["normal", "high", "urgent"].includes(priority)) throw new HttpError("Invalid handover routing.", 400);
    const saved = await persistWorkflow("handover", {
      userId,
      sourceTurnId,
      department,
      priority,
      status: "open",
      summary: boundedObject(args.summary || {}, 6000)
    });
    const handover = saved?.handover;
    if (!handover?.id) throw new Error("Handover persistence was not confirmed.");
    return { id: handover.id, status: handover.status, userSafeSummary: "Your request has been sent to the relevant team." };
  }

  if (name === "scheduleFollowUp") {
    if (args.purpose !== "specialist_follow_up") throw new HttpError("A specific follow-up purpose is required.", 400);
    const dueAt = new Date(String(args.dueAt || ""));
    if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() < Date.now() + 60_000 || dueAt.getTime() > Date.now() + 30 * 86400000) throw new HttpError("Choose a follow-up time within the next 30 days.", 400);
    const { data: consent, error: consentError } = await supabase.from("rafa_contact_consents").select("state,source_turn_id").eq("contact_id", contact.contactId).eq("consent_type", "follow_up").maybeSingle();
    if (consentError) throw consentError;
    if (!consent || consent.state !== "granted" || !consent.source_turn_id) throw new HttpError("Follow-up consent is required.", 403);
    const { data: consentTurn, error: turnError } = await supabase.from("rafa_conversation_turns").select("id,metadata").eq("id", consent.source_turn_id).eq("contact_id", contact.contactId).maybeSingle();
    if (turnError) throw turnError;
    if (!consentTurn || !hasPurposeBoundFollowUpConsent(consent, consentTurn)) throw new HttpError("Purpose-bound follow-up consent is required.", 403);
    const { data: reminderConsent, error: reminderError } = await supabase.from("rafa_contact_consents").select("consent_type,state,source_turn_id,offer_source_turn_id,language,channel").eq("contact_id", contact.contactId).eq("consent_type", "automated_reminder").maybeSingle();
    if (reminderError) throw reminderError;
    if (!reminderConsent || reminderConsent.state !== "granted" || !reminderConsent.source_turn_id || !reminderConsent.offer_source_turn_id) throw new HttpError("Automated reminder consent is required.", 403);
    const { data: reminderTurns, error: reminderTurnError } = await supabase.from("rafa_conversation_turns")
      .select("id,metadata,at").eq("contact_id", contact.contactId)
      .in("id", [reminderConsent.source_turn_id, reminderConsent.offer_source_turn_id]);
    if (reminderTurnError) throw reminderTurnError;
    const confirmationTurn = (reminderTurns || []).find((turn) => turn.id === reminderConsent.source_turn_id);
    const offerTurn = (reminderTurns || []).find((turn) => turn.id === reminderConsent.offer_source_turn_id);
    if (!confirmationTurn || !offerTurn || !hasPurposeBoundAutomatedReminderConsent(reminderConsent, confirmationTurn, offerTurn)) throw new HttpError("Purpose-bound automated reminder consent is required.", 403);
    const offerAt = Date.parse(String(offerTurn.at || "")), confirmationAt = Date.parse(String(confirmationTurn.at || ""));
    if (!Number.isFinite(offerAt) || !Number.isFinite(confirmationAt) || confirmationAt < offerAt) throw new HttpError("Automated reminder consent source is invalid.", 403);
    const { data: interveningTurns, error: interveningError } = await supabase.from("rafa_conversation_turns").select("id")
      .eq("contact_id", contact.contactId).gte("at", new Date(offerAt).toISOString()).lte("at", new Date(confirmationAt).toISOString()).order("at", { ascending: true });
    if (interveningError) throw interveningError;
    if (!areAdjacentConsentTurns(interveningTurns || [], offerTurn.id, confirmationTurn.id)) throw new HttpError("Automated reminder consent was not given immediately after its offer.", 403);
    const saved = await persistWorkflow("follow-up", { userId, consentState: "granted", status: "scheduled", nextDueAt: dueAt.toISOString() });
    if (!saved?.followUp?.contact_id) throw new Error("Follow-up schedule persistence was not confirmed.");
    return { id: saved.followUp.contact_id, status: "scheduled", userSafeSummary: "Your follow-up request is scheduled." };
  }

  if (name === "recordComplianceEvent") {
    const trigger = String(args.trigger || "");
    const allowed = new Set(["aml_concern", "sanctions_concern", "source_of_funds_unclear", "identity_mismatch", "high_risk_transaction"]);
    if (!allowed.has(trigger)) throw new HttpError("Unsupported compliance event category.", 400);
    const event = await logWorkflowAudit(contact.contactId, `m4_compliance_${trigger}`, {
      source_turn_id: sourceTurnId,
      language: ["ar", "en", "el"].includes(String(args.language || "")) ? args.language : "unknown"
    }, "system");
    return { id: event.id, status: "confirmed", userSafeSummary: "The matter was flagged for internal review." };
  }
  throw new HttpError("Unknown dynamic action.", 404);
}

async function workflowContact(body: Record<string, unknown>) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError("A JSON object is required.", 400);
  const userId = String(body.userId || "").trim();
  if (!validWhatsAppJid(userId)) throw new HttpError("A valid WhatsApp contact is required.", 400);
  const contact = await ensureUser(userId);
  const sourceTurnId = body.sourceTurnId ? String(body.sourceTurnId) : null;
  if (sourceTurnId) {
    if (!isUuid(sourceTurnId)) throw new HttpError("Invalid source turn ID.", 400);
    const { data, error } = await supabase.from("rafa_conversation_turns").select("id").eq("id", sourceTurnId).eq("contact_id", contact.contactId).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError("Source turn does not belong to this contact.", 400);
  }
  return { contact, sourceTurnId };
}

function boundedObject(value: unknown, max = 6000): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitize = (item: unknown, depth = 0): unknown => {
    if (depth > 3 || item === undefined || typeof item === "function") return undefined;
    if (typeof item === "string") return item.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000);
    if (typeof item === "number") return Number.isFinite(item) ? item : undefined;
    if (typeof item === "boolean") return item;
    if (Array.isArray(item)) return item.slice(0, 30).map((entry) => sanitize(entry, depth + 1)).filter((entry) => entry !== undefined);
    if (item && typeof item === "object") {
      const nested: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(item as Record<string, unknown>).slice(0, 30)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,50}$/.test(nestedKey) || ["evidence", "memory", "memories", "retrievedContent", "sourceContent"].includes(nestedKey)) continue;
        const clean = sanitize(nestedValue, depth + 1);
        if (clean !== undefined) nested[nestedKey] = clean;
      }
      return nested;
    }
    return undefined;
  };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,50}$/.test(key) || item === undefined || typeof item === "function") continue;
    if (["evidence", "memory", "memories", "retrievedContent", "sourceContent"].includes(key)) continue;
    const clean = sanitize(item);
    if (clean !== undefined) result[key] = clean;
  }
  const encoded = JSON.stringify(result);
  if (encoded.length > max) throw new HttpError("Workflow details are too large.", 400);
  return result;
}

function boundedScore(value: unknown) {
  const score = Number(value);
  if (!Number.isInteger(score) || score < 0 || score > 5) throw new HttpError("Qualification scores must be whole numbers from 0 to 5.", 400);
  return score;
}

async function persistWorkflow(kind: string, body: Record<string, unknown>) {
  const { contact, sourceTurnId } = await workflowContact(body);
  if (kind === "follow-up-claim") {
    const claimId = String(body.claimId || "");
    const consentTurnId = String(body.consentSourceTurnId || "");
    const triggerTurnId = String(body.triggerTurnId || "");
    if (!isUuid(claimId) || !isUuid(consentTurnId) || !isUuid(triggerTurnId) || triggerTurnId !== sourceTurnId) {
      throw new HttpError("A valid follow-up delivery claim is required.", 400);
    }
    const { data, error } = await supabase.rpc("rafa_claim_follow_up_send", {
      p_contact_id: contact.contactId,
      p_claim_id: claimId,
      p_consent_turn_id: consentTurnId,
      p_trigger_turn_id: triggerTurnId
    });
    if (error) throw error;
    return { claimed: data === true };
  }
  if (kind === "follow-up-result") {
    const claimId = String(body.claimId || "");
    const outcome = String(body.outcome || "");
    const triggerTurnId = String(body.triggerTurnId || "");
    const finishedAt = body.finishedAt === undefined ? new Date().toISOString() : String(body.finishedAt);
    const providerMessageId = body.providerMessageId === undefined ? null : String(body.providerMessageId).slice(0, 500);
    if (!isUuid(claimId) || !isUuid(triggerTurnId) || triggerTurnId !== sourceTurnId
      || !["sent", "retryable", "uncertain"].includes(outcome) || !Number.isFinite(Date.parse(finishedAt))) {
      throw new HttpError("A valid follow-up delivery outcome is required.", 400);
    }
    const errorCode = outcome === "uncertain" ? "provider_outcome_ambiguous"
      : outcome === "retryable" ? "provider_confirmed_not_sent" : null;
    const { data, error } = await supabase.rpc("rafa_finish_follow_up_send", {
      p_contact_id: contact.contactId,
      p_claim_id: claimId,
      p_outcome: outcome,
      p_error: errorCode,
      p_provider_message_id: providerMessageId,
      p_finished_at: finishedAt
    });
    if (error) throw error;
    return { finished: data === true };
  }
  if (kind === "lead-score") {
    const dimensions = Object.fromEntries(["need", "value", "timing", "authority", "readiness", "fit"].map((name) => [name, boundedScore((body.dimensions as Record<string, unknown> || {})[name])]));
    const scoreFloor = Number(body.scoreFloor || 0);
    const tier = String(body.tier || "");
    const scorerVersion = String(body.scorerVersion || "").slice(0, 80);
    const evidenceFingerprint = String(body.evidenceFingerprint || "");
    if (!Number.isInteger(scoreFloor) || scoreFloor < 0 || scoreFloor > 30 || !["informational", "cold", "warm", "hot", "strategic"].includes(tier) || !scorerVersion || !/^[a-f0-9]{64}$/.test(evidenceFingerprint)) throw new HttpError("Invalid lead score snapshot.", 400);
    const evidenceRefs = boundedObject(body.evidenceReferences, 6000);
    const { data, error } = await supabase.from("refal_lead_score").upsert({ contact_id: contact.contactId, ...dimensions, score_floor: scoreFloor, tier, evidence_refs: evidenceRefs, scorer_version: scorerVersion, evidence_fingerprint: evidenceFingerprint, source_turn_id: sourceTurnId }, { onConflict: "contact_id,evidence_fingerprint", ignoreDuplicates: true }).select("*").maybeSingle();
    if (error) throw error;
    return { score: data };
  }
  if (kind === "qualification") {
    const dimensions = Object.fromEntries(["need", "value", "timing", "authority", "readiness", "fit"].map((name) => [name, boundedScore((body.dimensions as Record<string, unknown> || {})[name])]));
    const total = Object.values(dimensions).reduce((sum, value) => sum + Number(value), 0);
    const thresholds = boundedObject(body.thresholds, 1000);
    const hot = Number(thresholds.hot ?? 20), warm = Number(thresholds.warm ?? 14), strategic = Number(thresholds.strategic ?? 25);
    if (!Number.isInteger(hot) || !Number.isInteger(warm) || !Number.isInteger(strategic) || warm < 0 || hot < warm || strategic < hot || strategic > 30 || hot > 30 || warm > 30) throw new HttpError("Invalid qualification thresholds.", 400);
    const priority = body.priority === true;
    const status = priority || total >= strategic ? "priority" : total >= hot ? "hot" : total >= warm ? "warm" : total > 0 ? "cold" : "unclassified";
    const { data, error } = await supabase.from("rafa_lead_qualifications").upsert({ contact_id: contact.contactId, ...dimensions, status, priority_reason: priority || total >= strategic ? String(body.priorityReason || "workflow_priority").slice(0, 120) : null, thresholds: { hot, warm, strategic }, source_turn_id: sourceTurnId }, { onConflict: "contact_id" }).select("*").single();
    if (error) throw error;
    await logWorkflowAudit(contact.contactId, "qualification_saved", { status, total }, "system");
    return { qualification: data };
  }
  if (kind === "intents") {
    const intents = [...new Set((Array.isArray(body.intents) ? body.intents : [body.intent]).map((value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_")))].filter(Boolean);
    if (!intents.length || intents.some((intent) => !WORKFLOW_INTENTS.has(intent))) throw new HttpError("Invalid intent taxonomy.", 400);
    const confidence = body.confidence === undefined ? null : Number(body.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new HttpError("Confidence must be between 0 and 1.", 400);
    const rows = intents.map((intent) => ({ contact_id: contact.contactId, intent, confidence, source: ["deterministic", "operator", "system"].includes(String(body.source)) ? String(body.source) : "deterministic", source_turn_id: sourceTurnId }));
    const { data, error } = await supabase.from("rafa_contact_intents").upsert(rows, { onConflict: "contact_id,intent" }).select("*");
    if (error) throw error;
    return { intents: data || [] };
  }
  if (kind === "consent") {
    const consentType = String(body.consentType || "follow_up");
    if (!["follow_up", "automated_reminder"].includes(consentType)) throw new HttpError("Unsupported consent scope.", 400);
    const state = String(body.state || "");
    if (!["unknown", "granted", "denied", "revoked"].includes(state)) throw new HttpError("Invalid consent state.", 400);
    const purpose = consentType === "automated_reminder" ? "automated_reminder" : "specialist_contact";
    const language = ["ar", "en", "el"].includes(String(body.language || "")) ? String(body.language) : "unknown";
    const channel = String(body.channel || "whatsapp");
    if (channel !== "whatsapp" || (state === "granted" && language === "unknown")) throw new HttpError("Consent provenance is incomplete.", 400);
    const offerSourceTurnId = body.offerSourceTurnId ? String(body.offerSourceTurnId) : null;
    if (state === "granted" && consentType === "automated_reminder") {
      if (!sourceTurnId || !offerSourceTurnId || !isUuid(offerSourceTurnId)) throw new HttpError("Automated reminder offer provenance is required.", 400);
      const { data: linkedTurns, error: linkedError } = await supabase.from("rafa_conversation_turns").select("id,metadata,at").eq("contact_id", contact.contactId).in("id", [sourceTurnId, offerSourceTurnId]);
      if (linkedError) throw linkedError;
      const confirmationTurn = (linkedTurns || []).find((turn) => turn.id === sourceTurnId);
      const offerTurn = (linkedTurns || []).find((turn) => turn.id === offerSourceTurnId);
      const consent = { consent_type: consentType, state, source_turn_id: sourceTurnId, offer_source_turn_id: offerSourceTurnId, language, channel };
      if (!confirmationTurn || !offerTurn || !hasPurposeBoundAutomatedReminderConsent(consent, confirmationTurn, offerTurn)) throw new HttpError("Automated reminder consent must affirm a tracked reminder offer.", 403);
      const offerAt = Date.parse(String(offerTurn.at || "")), confirmationAt = Date.parse(String(confirmationTurn.at || ""));
      if (!Number.isFinite(offerAt) || !Number.isFinite(confirmationAt) || confirmationAt < offerAt) throw new HttpError("Automated reminder offer provenance is invalid.", 403);
      const { data: adjacentTurns, error: adjacentError } = await supabase.from("rafa_conversation_turns").select("id").eq("contact_id", contact.contactId)
        .gte("at", new Date(offerAt).toISOString()).lte("at", new Date(confirmationAt).toISOString()).order("at", { ascending: true });
      if (adjacentError) throw adjacentError;
      if (!areAdjacentConsentTurns(adjacentTurns || [], offerSourceTurnId, sourceTurnId)) throw new HttpError("Reminder consent must immediately follow its offer.", 403);
    }
    const { data, error } = await supabase.from("rafa_contact_consents").upsert({ contact_id: contact.contactId, consent_type: consentType, state, purpose, language, channel, source_turn_id: sourceTurnId, offer_source_turn_id: offerSourceTurnId }, { onConflict: "contact_id,consent_type" }).select("*").single();
    if (error) throw error;
    if (consentType === "follow_up") {
      const { error: followUpError } = await supabase.from("rafa_follow_up_states").upsert({ contact_id: contact.contactId, consent_state: state, status: state === "granted" ? "eligible" : "suppressed" }, { onConflict: "contact_id" });
      if (followUpError) throw followUpError;
    }
    return { consent: data };
  }
  if (kind === "follow-up") {
    const state = String(body.consentState || "unknown");
    const status = String(body.status || "idle");
    if (!["unknown", "granted", "denied", "revoked"].includes(state) || !["idle", "eligible", "scheduled", "sent", "suppressed"].includes(status)) throw new HttpError("Invalid follow-up state.", 400);
    if (status === "eligible" || status === "scheduled" || status === "sent") { if (state !== "granted") throw new HttpError("Follow-up cannot proceed without granted consent.", 400); }
    const patch = { contact_id: contact.contactId, consent_state: state, status, next_due_at: body.nextDueAt || null, last_sent_at: body.lastSentAt || null };
    for (const value of [patch.next_due_at, patch.last_sent_at]) if (value !== null && (!String(value).length || !Number.isFinite(Date.parse(String(value))))) throw new HttpError("Invalid follow-up timestamp.", 400);
    const { data, error } = await supabase.from("rafa_follow_up_states").upsert(patch, { onConflict: "contact_id" }).select("*").single();
    if (error) throw error;
    return { followUp: data };
  }
  if (kind === "opportunity-intake") {
    const intakeType = String(body.type || ""), status = String(body.status || "in_progress");
    if (!["company_formation", "real_estate", "land_development", "construction", "investment", "partnership", "appointment"].includes(intakeType)) throw new HttpError("Invalid opportunity intake type.", 400);
    if (!["in_progress", "ready_for_review", "handed_over", "completed"].includes(status)) throw new HttpError("Invalid opportunity intake status.", 400);
    const values = { contact_id: contact.contactId, intake_type: intakeType, data: boundedObject(body.data, 12000), provenance: boundedObject(body.provenance, 6000), status, source_turn_id: sourceTurnId };
    const { data, error } = await supabase.from("rafa_opportunity_intakes").upsert(values, { onConflict: "contact_id,intake_type" }).select("*").single();
    if (error) throw error;
    return { intake: data };
  }
  if (kind === "handover") {
    const department = String(body.department || "general"), priority = String(body.priority || "normal"), status = String(body.status || "open");
    if (!WORKFLOW_DEPARTMENTS.has(department) || !["normal", "high", "urgent"].includes(priority) || !["open", "acknowledged", "resolved", "cancelled"].includes(status)) throw new HttpError("Invalid handover state.", 400);
    const summary = sanitizeHandoverSummary(boundedObject(body.summary, 12000));
    const values = { contact_id: contact.contactId, department, priority, status, summary, source_turn_id: sourceTurnId, resolved_at: status === "resolved" || status === "cancelled" ? new Date().toISOString() : null };
    if (status === "open" || status === "acknowledged") {
      const { data: existing, error: lookupError } = await supabase.from("rafa_handovers").select("id,contact_id,department,priority,status,summary,source_turn_id,created_at").eq("contact_id", contact.contactId).in("status", ["open", "acknowledged"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) {
        const patch = mergeActiveHandover(existing, values, { sourceTurnId });
        const { data, error } = await supabase.from("rafa_handovers").update(patch).eq("id", existing.id).select("*").single();
        if (error) throw error;
        await queueHandoverDelivery(existing.id, department);
        return { handover: data, merged: true };
      }
    }
    const { data, error } = await supabase.from("rafa_handovers").insert(values).select("*").single();
    if (error?.code === "23505" && (status === "open" || status === "acknowledged")) {
      const { data: concurrent, error: retryLookupError } = await supabase.from("rafa_handovers").select("id,contact_id,department,priority,status,summary,source_turn_id,created_at").eq("contact_id", contact.contactId).in("status", ["open", "acknowledged"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (retryLookupError) throw retryLookupError;
      if (concurrent) {
        const patch = mergeActiveHandover(concurrent, values, { sourceTurnId });
        const { data: updated, error: updateError } = await supabase.from("rafa_handovers").update(patch).eq("id", concurrent.id).select("*").single();
        if (updateError) throw updateError;
        await queueHandoverDelivery(concurrent.id, department);
        return { handover: updated, merged: true };
      }
    }
    if (error) throw error;
    await queueHandoverDelivery(data.id, department);
    return { handover: data };
  }
  if (kind === "priority-alert") {
    const level = String(body.level || ""), trigger = String(body.trigger || "");
    if (!["high", "urgent"].includes(level) || !WORKFLOW_TRIGGERS.has(trigger)) throw new HttpError("Invalid priority alert.", 400);
    const values = { contact_id: contact.contactId, level, trigger, status: "open", details: boundedObject(body.details), source_turn_id: sourceTurnId };
    const { data: existing, error: lookupError } = await supabase.from("rafa_priority_alerts").select("id").eq("contact_id", contact.contactId).eq("trigger", trigger).in("status", ["open", "acknowledged"]).maybeSingle();
    if (lookupError) throw lookupError;
    const query = existing
      ? supabase.from("rafa_priority_alerts").update(values).eq("id", existing.id)
      : supabase.from("rafa_priority_alerts").insert(values);
    const { data, error } = await query.select("*").single();
    if (error) throw error;
    return { alert: data };
  }
  if (kind === "complaint") {
    const severity = String(body.severity || "high"), summary = String(body.summary || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!["high", "urgent"].includes(severity) || !summary || summary.length > 2000) throw new HttpError("A valid complaint severity and summary are required.", 400);
    const { data, error } = await supabase.from("rafa_complaints").insert({ contact_id: contact.contactId, severity, summary, source_turn_id: sourceTurnId }).select("*").single();
    if (error) throw error;
    return { complaint: data };
  }
  if (kind === "existing-client-verification") {
    const state = String(body.state || "unauthenticated"), attempts = Number(body.attempts || 0), verified = state === "authenticated";
    if (!["unauthenticated", "awaiting_identifier", "awaiting_verification", "authenticated", "failed", "locked"].includes(state) || !Number.isInteger(attempts) || attempts < 0 || attempts > 3) throw new HttpError("Invalid verification state.", 400);
    if (verified) throw new HttpError("Authenticated client state requires an independent verification flow.", 403);
    const { data, error } = await supabase.from("rafa_existing_client_verifications").upsert({ contact_id: contact.contactId, state, attempts, identifier_provided: Boolean(body.identifierProvided), verified, account_disclosure_allowed: verified, verified_at: verified ? new Date().toISOString() : null }, { onConflict: "contact_id" }).select("*").single();
    if (error) throw error;
    return { verification: data };
  }
  if (kind === "audit-event") {
    const event = String(body.event || "").trim(), actorType = String(body.actorType || "system");
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(event) || !["system", "customer", "operator", "admin"].includes(actorType)) throw new HttpError("Invalid audit event.", 400);
    return { auditEvent: await logWorkflowAudit(contact.contactId, event, boundedObject(body.details), actorType) };
  }
  throw new HttpError("Unknown workflow.", 404);
}

async function logWorkflowAudit(contactId: string | null, event: string, details: Record<string, unknown>, actorType: string) {
  const { data, error } = await supabase.from("rafa_audit_events").insert({ contact_id: contactId, event, actor_type: actorType, details }).select("*").single();
  if (error) throw error;
  return data;
}

async function queueHandoverDelivery(handoverId: string, department: string) {
  const { data: existing, error: lookupError } = await supabase.from("refal_handover_delivery").select("id").eq("handover_id", handoverId).maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    const { data, error } = await supabase.from("refal_handover_delivery").update({ department, updated_at: new Date().toISOString() }).eq("handover_id", handoverId).select("*").single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from("refal_handover_delivery").insert({ handover_id: handoverId, department, recipient_lane: "sandbox", status: "queued", next_attempt_at: new Date().toISOString() }).select("*").single();
  if (error?.code === "23505") return { id: handoverId };
  if (error) throw error;
  return data;
}

async function reconcileHandoverReviewQueue() {
  // The manual retry endpoint updates the existing job first and the ledger
  // second. If that second write fails, recover the failed ledger from the
  // active review job before the normal queued/retry repair pass.
  const { data: activeReviews, error: activeReviewError } = await supabase.from("rafa_notification_jobs")
    .select("id,handover_id,status")
    .eq("kind", "handover_review")
    .in("status", ["queued", "processing"])
    .not("handover_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(25);
  if (activeReviewError) throw activeReviewError;
  for (const notification of activeReviews || []) {
    const { data: parent, error: parentError } = await supabase.from("rafa_handovers")
      .select("status").eq("id", notification.handover_id).maybeSingle();
    if (parentError) throw parentError;
    const closedPatch = ledgerPatchForClosedHandover(parent?.status);
    if (closedPatch) {
      await closeHandoverDeliverySafely({
        cancelActiveNotifications: async () => {
          const { error } = await supabase.from("rafa_notification_jobs")
            .update({ status: "cancelled", locked_at: null, last_error: "Handover is closed." })
            .eq("id", notification.id).in("status", ["queued", "processing"]);
          if (error) throw error;
        },
        closeDelivery: async () => {
          const { error } = await supabase.from("refal_handover_delivery")
            .update(closedPatch).eq("handover_id", notification.handover_id).neq("status", "closed");
          if (error) throw error;
        }
      });
      continue;
    }
    const retryPatch = ledgerPatchForRetryMismatch(notification.status);
    if (!retryPatch) continue;
    const { error: retryReconcileError } = await supabase.from("refal_handover_delivery")
      .update(retryPatch)
      .eq("handover_id", notification.handover_id)
      .eq("status", "failed");
    if (retryReconcileError) throw retryReconcileError;
  }

  const { data: pending, error } = await supabase.from("refal_handover_delivery")
    .select("handover_id,department")
    .in("status", ["queued", "retry"])
    .lte("next_attempt_at", new Date().toISOString())
    .order("updated_at", { ascending: true })
    .limit(25);
  if (error) throw error;
  for (const delivery of pending || []) {
    const { data: handover, error: handoverError } = await supabase.from("rafa_handovers")
      .select("id,department,priority,summary,status")
      .eq("id", delivery.handover_id)
      .eq("department", delivery.department)
      .maybeSingle();
    if (handoverError) throw handoverError;
    if (!handover) continue;
    const closedPatch = ledgerPatchForClosedHandover(handover.status);
    if (closedPatch) {
      await closeHandoverDeliverySafely({
        cancelActiveNotifications: async () => {
          const { error } = await supabase.from("rafa_notification_jobs")
            .update({ status: "cancelled", locked_at: null, last_error: "Handover is closed." })
            .eq("handover_id", delivery.handover_id).eq("kind", "handover_review").in("status", ["queued", "processing"]);
          if (error) throw error;
        },
        closeDelivery: async () => {
          const { error } = await supabase.from("refal_handover_delivery")
            .update(closedPatch).eq("handover_id", delivery.handover_id).in("status", ["queued", "retry"]);
          if (error) throw error;
        }
      });
      continue;
    }
    const { data: existing, error: existingError } = await supabase.from("rafa_notification_jobs")
      .select("id,status")
      .eq("handover_id", delivery.handover_id)
      .eq("kind", "handover_review")
      .in("status", ["queued", "processing", "sent", "dead", "cancelled"])
      .limit(1);
    if (existingError) throw existingError;
    const notification = existing?.[0];
    const reconciliationPatch = notification ? ledgerPatchForExistingNotification(notification.status) : null;
    if (reconciliationPatch) {
      const { error: reconcileError } = await supabase.from("refal_handover_delivery")
        .update(reconciliationPatch)
        .eq("handover_id", delivery.handover_id)
        .in("status", ["queued", "retry"]);
      if (reconcileError) throw reconcileError;
      continue;
    }
    if (notification) continue;
    const summary = handover.summary && typeof handover.summary === "object" ? handover.summary : {};
    const customer = summary.customer && typeof summary.customer === "object" ? summary.customer : {};
    const { error: insertError } = await supabase.from("rafa_notification_jobs").insert({
      handover_id: handover.id,
      channel: "email",
      kind: "handover_review",
      recipient: "sandbox@refalco.test",
      status: "queued",
      idempotency_key: `handover:${handover.id}:admin-review-email`,
      payload: {
        department: handover.department,
        priority: handover.priority || "normal",
        intent: summary.intent || summary.primaryIntent || "",
        name: customer.name || "",
        need: summary.need || summary.opportunity || ""
      }
    });
    if (insertError && insertError.code !== "23505") throw insertError;
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validWhatsAppJid(value: string) {
  return /^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(value);
}

function blockIdentities(value: string) {
  const [name, server] = value.split("@");
  if (/^\d+$/.test(name) && ["s.whatsapp.net", "c.us"].includes(server)) return [`${name}@s.whatsapp.net`, `${name}@c.us`];
  return [value];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

class HttpError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function validateBookingPolicy(value: Record<string, any>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Booking policy must be an object.");
  const timezone = String(value.timezone || "").trim();
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new Error("Choose a valid IANA timezone."); }
  const calendarId = String(value.calendarId || "").trim();
  if (!calendarId || calendarId.length > 320 || /\s/.test(calendarId)) throw new Error("Choose a valid calendar ID.");
  if (!Array.isArray(value.weekdays)) throw new Error("Choose one or more weekdays (Monday-Friday).");
  const weekdays = [...new Set(value.weekdays)].sort((a, b) => a - b);
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 5)) throw new Error("Choose one or more weekdays (Monday-Friday).");
  const validTime = (time: unknown) => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (!validTime(value.startTime) || !validTime(value.endTime) || minutes(value.endTime) <= minutes(value.startTime)) throw new Error("Enter a valid same-day start and end time.");
  const durationMinutes = value.durationMinutes === null || value.durationMinutes === "" ? null : Number(value.durationMinutes);
  if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240)) throw new Error("Duration must be between 1 and 240 minutes.");
  if (typeof value.durationOwnerConfirmed !== "boolean" || (value.durationOwnerConfirmed && durationMinutes === null)) throw new Error("Set and confirm the appointment duration.");
  const minimumNoticeHours = value.minimumNoticeHours === null || value.minimumNoticeHours === "" ? null : Number(value.minimumNoticeHours);
  if (minimumNoticeHours !== null && (!Number.isFinite(minimumNoticeHours) || minimumNoticeHours < 0 || minimumNoticeHours > 8760)) throw new Error("Minimum notice must be between 0 and 8760 hours.");
  if (!Array.isArray(value.reminderHours) || value.reminderHours.length > 6 || value.reminderHours.some((hours) => !Number.isInteger(hours) || hours < 1 || hours > 8760)) throw new Error("Reminder offsets must be whole hours between 1 and 8760.");
  return { timezone, calendarId, weekdays, startTime: value.startTime, endTime: value.endTime, durationMinutes,
    durationOwnerConfirmed: value.durationOwnerConfirmed, minimumNoticeHours,
    reminderHours: [...new Set(value.reminderHours)].sort((a, b) => b - a),
    createMeetLink: Boolean(value.createMeetLink) };
}

async function logEvent(event: string, fields: Record<string, unknown>) {
  const { error } = await supabase.from("rafa_events").insert({
    event,
    fields: event.startsWith("agent_") ? sanitizeAgentOperationalFields(fields) : redactAuditEventFields(fields),
    at: new Date().toISOString()
  });
  if (error) throw error;
}

async function listEvents(limit: number) {
  const { data, error } = await supabase
    .from("rafa_events")
    .select("event,fields,at")
    .neq("event", "agent_controlled_inspection")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((row) => ({
    at: row.at,
    ...(row.fields || {}),
    event: row.event,
    fields: row.fields || {}
  })).reverse();
}

async function attachHistory(user: Record<string, any>) {
  const { data, error } = await supabase
    .from("rafa_conversation_turns")
    .select("id,at,message,response,automated,source,metadata")
    .eq("user_id", user.id)
    .order("at", { ascending: true });
  if (error) throw error;
  return { ...user, history: data || [] };
}

function rowToUser(row: Record<string, any>, history: unknown[]) {
  return {
    contactId: row.id,
    id: row.whatsapp_jid,
    phone: row.phone || String(row.whatsapp_jid || "").replace(/@.+$/, ""),
    profile: row.profile || {},
    followUpBlocked: row.profile?.followUpBlocked === true,
    step: row.step,
    whatsapp: row.whatsapp || {},
    booking: row.booking || undefined,
    lastFollowUpSent: row.last_follow_up_sent || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    history
  };
}

async function attachCrmProfile(user: Record<string, any>, suppliedRow?: Record<string, any> | null) {
  if (!user?.contactId) return user;
  let row = suppliedRow;
  if (arguments.length < 2) {
    const { data, error } = await supabase.from("refal_lead_profile")
      .select("contact_id,identity_fields,opportunity_fields,property_residency_fields,qualification_fields,field_provenance,crm_correction_needed")
      .eq("contact_id", user.contactId).maybeSingle();
    if (error) throw error;
    row = data;
  }
  const projection = crmRowToAgentFacts(row);
  const profile = {
    ...(user.profile || {}),
    agentFacts: { ...(user.profile?.agentFacts || {}), ...projection.agentFacts }
  };
  if (projection.hasRow) {
    if (projection.crmCorrectionNeeded) profile.crmCorrectionNeeded = projection.crmCorrectionNeeded;
    else delete profile.crmCorrectionNeeded;
  }
  return {
    ...user,
    profile
  };
}

async function attachWorkflowState(user: Record<string, any>) {
  const contactId = user.contactId;
  if (!contactId) return user;
  const [consentResult, automatedReminderResult, followUpResult, qualificationResult, existingClientResult] = await Promise.all([
    supabase.from("rafa_contact_consents").select("state,observed_at").eq("contact_id", contactId).eq("consent_type", "follow_up").maybeSingle(),
    supabase.from("rafa_contact_consents").select("state,observed_at").eq("contact_id", contactId).eq("consent_type", "automated_reminder").maybeSingle(),
    supabase.from("rafa_follow_up_states").select("consent_state,status,next_due_at,last_sent_at,delivery_state,delivery_claimed_at,delivery_consent_turn_id,delivery_trigger_turn_id,delivery_error,provider_message_id,updated_at").eq("contact_id", contactId).maybeSingle(),
    supabase.from("rafa_lead_qualifications").select("need,value,timing,authority,readiness,fit,total,status,priority_reason,thresholds,assessed_at").eq("contact_id", contactId).maybeSingle(),
    supabase.from("rafa_existing_client_verifications").select("state,attempts,identifier_provided,verified,account_disclosure_allowed,verified_at,updated_at").eq("contact_id", contactId).maybeSingle()
  ]);
  for (const result of [consentResult, automatedReminderResult, followUpResult, qualificationResult, existingClientResult]) if (result.error) throw result.error;
  const consent = consentResult.data;
  const automatedReminderConsent = automatedReminderResult.data;
  const followUpState = followUpResult.data;
  const qualification = qualificationResult.data;
  const existingClient = existingClientResult.data;
  return {
    ...user,
    consent: consent || automatedReminderConsent ? {
      ...(consent ? { followUp: consent.state, followUpUpdatedAt: consent.observed_at } : {}),
      ...(automatedReminderConsent ? { automatedReminder: automatedReminderConsent.state, automatedReminderUpdatedAt: automatedReminderConsent.observed_at } : {})
    } : undefined,
    followUpState: followUpState || undefined,
    leadQualification: qualification || undefined,
    profile: existingClient ? { ...(user.profile || {}), existingClientState: {
      state: existingClient.state,
      attempts: existingClient.attempts,
      identifierProvided: existingClient.identifier_provided,
      verified: existingClient.verified,
      accountDisclosureAllowed: existingClient.account_disclosure_allowed,
      verifiedAt: existingClient.verified_at
    } } : user.profile
  };
}

function cleanTitle(value: string) {
  const title = value.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 80) : "New chat";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json"
    }
  });
}
