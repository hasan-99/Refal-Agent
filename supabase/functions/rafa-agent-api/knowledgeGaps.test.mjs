import test from "node:test";
import assert from "node:assert/strict";
import {
  GAP_DRAFT_ANSWER_MARKER, buildKnowledgeDraftPrefill, classifyExpiredUpgrade, classifyKnowledgeGap, compareAspects, computeGapPriority,
  containsObviousPii, decideGapGroup, gapCategoryForIntents, gapFingerprint, planGapAction, questionAspects, redactGapText, updateCentroid
} from "./knowledgeGapPolicy.mjs";
import { recordKnowledgeGapEvent, sanitizeGapEventInput } from "./knowledgeGapEvents.mjs";

const unit = (values) => { const n = Math.hypot(...values); return values.map((v) => v / n); };
const vec = (seed) => unit(Array.from({ length: 384 }, (_v, i) => Math.sin(i * 0.37 + seed) + (i % 7 === seed % 7 ? 0.5 : 0)));

test("redaction removes contact, identity, payment and address values but keeps the topic words", () => {
  const raw = "My email is jane.doe@example.com, call +357 99 123456, passport K1234567, IBAN CY17002001280000001200527600, card 4111 1111 1111 1111, I live at 12 Makarios Avenue. Can I change my company address?";
  const redacted = redactGapText(raw);
  for (const leak of ["jane.doe", "99 123456", "K1234567", "CY17002001280000001200527600", "4111", "Makarios"]) assert.equal(redacted.includes(leak), false, leak);
  assert.match(redacted, /Can I change my company address\?/u);
  assert.equal(containsObviousPii(redacted), false);
  assert.equal(redactGapText(redacted), redacted, "idempotent");
  assert.equal(redactGapText("هل أقدر أغير عنوان الشركة؟"), "هل أقدر أغير عنوان الشركة؟");
  assert.equal(redactGapText("رقم الجواز N9876543 وهاتفي 0035799123456").includes("9876543"), false);
  assert.equal(redactGapText("How much does company registration cost in 2026?"), "How much does company registration cost in 2026?");
});

test("decision table: system failures are never missing knowledge", () => {
  assert.equal(classifyKnowledgeGap({ outcome: "decision_failed", turnReason: "PROMPT_TOKEN_CEILING_EXCEEDED" }).reason, "system_failure");
  assert.equal(classifyKnowledgeGap({ outcome: "response_rejected", searches: [{ status: "error", evidenceCount: 0 }], stepReasonCodes: ["RETRIEVAL_FAILED"] }).reason, "system_failure");
  assert.equal(classifyKnowledgeGap({ outcome: "validation_failed", turnReason: "grounding_review_failed" }).reason, "system_failure");
  assert.equal(classifyKnowledgeGap({ outcome: "responded", stepReasonCodes: ["OPENROUTER_HTTP_502"], searches: [{ status: "no_evidence", evidenceCount: 0 }] }).reason, "system_failure");
});

test("decision table rows: skip, missing, weak, partial, expired, conflicting, unsupported, agent, needs_review", () => {
  assert.equal(classifyKnowledgeGap({ socialOnlyTurn: true, outcome: "responded" }).record, false);
  assert.equal(classifyKnowledgeGap({ intents: ["greeting"], outcome: "responded" }).record, false);
  assert.equal(classifyKnowledgeGap({ outcome: "responded", searches: [{ status: "found", evidenceCount: 3 }] }).record, false, "grounded answer");
  assert.equal(classifyKnowledgeGap({ outcome: "response_rejected", rejectionCodes: ["no_approved_evidence"], searches: [{ status: "no_evidence", evidenceCount: 0 }] }).reason, "missing_knowledge");
  const weak = classifyKnowledgeGap({ outcome: "response_rejected", rejectionCodes: ["entities_not_in_evidence"], searches: [{ status: "found", evidenceCount: 4, candidateCount: 12, primaryMatchCount: 0 }] });
  assert.equal(weak.reason, "weak_retrieval");
  assert.equal(classifyKnowledgeGap({ outcome: "responded", corrected: true, rejectionCodes: ["no_approved_evidence"], searches: [{ status: "found", evidenceCount: 2, primaryMatchCount: 2 }] }).reason, "partial_knowledge");
  assert.equal(classifyKnowledgeGap({ outcome: "response_rejected", expiredMatches: 1, searches: [{ status: "no_evidence", evidenceCount: 0 }] }).reason, "expired_knowledge");
  assert.equal(classifyExpiredUpgrade("missing_knowledge", 2), "expired_knowledge");
  assert.equal(classifyExpiredUpgrade("weak_retrieval", 2), "weak_retrieval");
  assert.equal(classifyKnowledgeGap({ outcome: "response_rejected", rejectionCodes: ["contradicted_by_evidence"], evidenceOverlap: true, searches: [{ status: "found", evidenceCount: 2 }] }).reason, "conflicting_knowledge");
  const unsupported = classifyKnowledgeGap({ outcome: "clarify_rejected", intents: ["privacy"] });
  assert.equal(unsupported.reason, "unsupported_request");
  assert.equal(unsupported.analyticsOnly, true);
  assert.equal(classifyKnowledgeGap({ outcome: "response_rejected", rejectionCodes: ["context_mismatch", "language_mismatch"], searches: [{ status: "found", evidenceCount: 3, primaryMatchCount: 1 }] }).reason, "agent_failure");
  assert.equal(classifyKnowledgeGap({ outcome: "response_rejected", rejectionCodes: ["no_approved_evidence"] }).reason, "agent_failure", "no search ran");
  const mixed = classifyKnowledgeGap({ outcome: "response_rejected", rejectionCodes: ["no_approved_evidence", "context_mismatch"], searches: [{ status: "found", evidenceCount: 2, primaryMatchCount: 1 }] });
  assert.equal(mixed.reason, "needs_review");
  assert.equal(mixed.confidence, "low");
});

test("aspect guard blocks keyword-sharing questions that need different knowledge", () => {
  const address = questionAspects("Can I change my company address?");
  assert.deepEqual(address, { facets: ["change"], objects: ["company_address"] });
  assert.equal(compareAspects(address, questionAspects("هل أقدر أغير عنوان الشركة؟")), "strong");
  assert.equal(compareAspects(address, questionAspects("Can I change my company name later?")), "conflict");
  assert.equal(compareAspects(address, questionAspects("What is your office address?")), "conflict");
  assert.equal(compareAspects(questionAspects("كم تكلفة تسجيل الشركة؟"), questionAspects("كم يستغرق تسجيل الشركة؟")), "conflict");
});

test("grouping joins a strong compatible match and never merges across lanes, categories or aspect conflicts", () => {
  const base = vec(1);
  const candidates = [{ id: "g1", similarity: 0.97, category: "corporate", reason: "missing_knowledge", facets: ["change"], objects: ["company_address"] }];
  assert.equal(decideGapGroup({ category: "corporate", reason: "weak_retrieval", question: "Can registered office be changed later?" }, candidates).groupId, "g1");
  assert.equal(decideGapGroup({ category: "corporate", reason: "system_failure", question: "Can registered office be changed later?" }, candidates).groupId, null);
  assert.equal(decideGapGroup({ category: "immigration", reason: "missing_knowledge", question: "Can registered office be changed later?" }, candidates).groupId, null);
  assert.equal(decideGapGroup({ category: "corporate", reason: "missing_knowledge", question: "Can I change my company name later?" }, candidates).groupId, null);
  const unknown = [{ id: "g2", similarity: 0.92, category: "corporate", reason: "missing_knowledge", facets: [], objects: [] }];
  assert.equal(decideGapGroup({ category: "corporate", reason: "missing_knowledge", question: "Does my company need an annual audit?" }, unknown).groupId, null, "unknown aspects need a near-duplicate");
  const merged = updateCentroid(base, 3, vec(2));
  assert.ok(Math.abs(Math.hypot(...merged) - 1) < 1e-9);
});

test("category picks the most specific domain; pricing questions about formation stay corporate", () => {
  assert.deepEqual(gapCategoryForIntents(["pricing", "company_formation"]), { category: "corporate", intent: "company_formation" });
  assert.equal(gapCategoryForIntents(["general_information"]).category, "general");
  assert.equal(gapFingerprint("Can I change my company address?"), gapFingerprint("  can i CHANGE my company address "));
});

test("priority formula, floors, caps and override", () => {
  assert.equal(computeGapPriority({ count: 1 }).priority, "low");
  assert.equal(computeGapPriority({ count: 25, last7Days: 10, previous7Days: 2, distinctContacts: 9, blocking: true, sensitiveTopics: ["price"], noSafeAnswerCount: 20 }).priority, "critical");
  assert.equal(computeGapPriority({ count: 3, sensitiveTopics: ["refund"], noSafeAnswerCount: 1 }).priority, "high", "sensitive + no safe answer floor");
  assert.equal(computeGapPriority({ count: 40, last7Days: 30, distinctContacts: 20, reason: "unsupported_request" }).priority, "low");
  assert.equal(computeGapPriority({ count: 40, last7Days: 30, distinctContacts: 20, blocking: true, reason: "system_failure" }).priority, "medium");
  assert.equal(computeGapPriority({ count: 1, override: "critical" }).priority, "critical");
});

test("actions follow the status rules; Create Knowledge prefill carries questions only, never facts", () => {
  assert.equal(planGapAction("reopen", "open").ok, false);
  assert.equal(planGapAction("reopen", "verified").status, "open");
  assert.deepEqual(planGapAction("link_existing", "open", { markWeakRetrieval: true }), { ok: true, status: "needs_retrieval_fix", reason: "weak_retrieval", requiresReason: false });
  assert.equal(planGapAction("ignore", "open").requiresReason, true);
  const prefill = buildKnowledgeDraftPrefill({ title: "Can I change my company address?", category: "corporate", intent: "company_formation", languages: ["en", "ar"] },
    [{ question: "هل أقدر أغير عنوان الشركة؟ jane@example.com" }]);
  assert.equal(prefill.title, "Can I change my company address?");
  assert.ok(prefill.content.includes(GAP_DRAFT_ANSWER_MARKER));
  assert.equal(prefill.content.includes("jane@example.com"), false);
  assert.deepEqual(prefill.questions.length, 2);
  assert.equal(/\d{2,}\s*(?:EUR|€)|fee is|costs? \d/iu.test(prefill.content), false, "no generated facts");
});

function fakeSupabase({ candidates = [], expired = [], contactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", recordResult = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return { select() { return { eq() { return { maybeSingle: async () => { calls.push(["from", table]); return { data: contactId ? { id: contactId } : null, error: null }; } }; } }; } };
    },
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "rafa_knowledge_gap_expired_matches") return { data: expired, error: null };
      if (name === "rafa_match_knowledge_gap_groups") return { data: candidates, error: null };
      return { data: recordResult || { suppressed: false, groupId: args.p_group_id || "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", created: !args.p_group_id }, error: null };
    }
  };
}

test("Edge sanitizer re-redacts, drops unknown fields and rejects unknown reasons", () => {
  const parsed = sanitizeGapEventInput({ question: "Call me on +357 99 123456 about the company address change", reason: "missing_knowledge", extra: "x",
    searchQueries: ["address change for jane@example.com"], embedding: vec(3), topChunks: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", rank: 1 }] });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.question.includes("99 123456"), false);
  assert.equal(parsed.value.searchQueries[0].includes("jane@"), false);
  assert.equal("extra" in parsed.value, false);
  assert.equal(parsed.value.embedding.length, 384);
  assert.equal(sanitizeGapEventInput({ question: "x", reason: "made_up" }).ok, false);
});

test("Edge recording stores the contact uuid (not the phone), upgrades expired knowledge and applies the grouping decision", async () => {
  const supabase = fakeSupabase({ expired: [{ chunk_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
    candidates: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", similarity: 0.95, category: "corporate", reason: "expired_knowledge", facets: ["change"], objects: ["company_address"] }] });
  const result = await recordKnowledgeGapEvent(supabase, { userId: "35799123456@s.whatsapp.net", question: "Can registered office be changed later?", reason: "missing_knowledge",
    category: "corporate", intent: "company_formation", embedding: vec(4), language: "english" });
  assert.equal(result.reason, "expired_knowledge");
  assert.equal(result.groupId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  const record = supabase.calls.find(([name]) => name === "rafa_record_knowledge_gap_event")[1];
  assert.equal(record.p_event.contact_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(JSON.stringify(record).includes("35799123456"), false, "the WhatsApp id never reaches storage");
  assert.equal(record.p_event.language, "en");
  assert.equal(record.p_rate_limit_seconds, 600);
});

test("knowledge gap settings accept only a boolean recording flag and default to on", async () => {
  const { validateKnowledgeGapSettings, readKnowledgeGapSettings, KNOWLEDGE_GAP_SETTINGS_KEY } = await import("./knowledgeGapPolicy.mjs");
  assert.equal(KNOWLEDGE_GAP_SETTINGS_KEY, "knowledge_gaps");
  assert.deepEqual(validateKnowledgeGapSettings({ recording: false, extra: "dropped" }), { recording: false });
  for (const bad of [null, [], "on", { recording: "true" }, { recording: 1 }, {}]) assert.throws(() => validateKnowledgeGapSettings(bad));
  assert.deepEqual(readKnowledgeGapSettings(undefined), { recording: true });
  assert.deepEqual(readKnowledgeGapSettings({ recording: false, updatedBy: "a@b.c" }), { recording: false });
});
