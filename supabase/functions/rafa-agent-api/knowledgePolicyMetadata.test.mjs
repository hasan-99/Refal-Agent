import { test } from "node:test";
import assert from "node:assert/strict";
import { attachKnowledgePolicyMetadata, policyMetadataForRow } from "./knowledgePolicyMetadata.mjs";

const CHUNK = "123e4567-e89b-42d3-a456-426614174000";

test("policy metadata enrichment batches chunk and fact reads and returns only bounded governance fields", async () => {
  const calls = [];
  const supabase = {
    from(table) {
      calls.push({ table });
      return {
        select(columns) {
          calls.at(-1).columns = columns;
          return this;
        },
        in(column, values) {
          calls.at(-1).filter = { column, values };
          return Promise.resolve(table === "rafa_knowledge_chunks"
            ? { data: [{ id: CHUNK, metadata: { topic: "jurisdiction-dubai", topicNumber: 26, facts: ["MB-J0", "MB-J1", "ignore-me"] } }], error: null }
            : { data: [{ fact_id: "MB-J0", status: "approved", reviewer: "BOSS", verified_at: "2026-10-01T00:00:00Z", effective_from: null, expiry_or_review_at: "2026-12-30", approved_languages: ["en", "ar", "el", "invalid"] }], error: null });
        }
      };
    }
  };
  const rows = await attachKnowledgePolicyMetadata(supabase, [{ chunk_id: CHUNK, review_status: "approved", valid_until: "2026-12-01T00:00:00Z", content: "approved text" }]);
  assert.deepEqual(calls.map((call) => call.table), ["rafa_knowledge_chunks", "refal_fact_register"]);
  assert.deepEqual(calls[1].filter.values, ["MB-J0", "MB-J1"]);
  assert.deepEqual(rows[0].policyMetadata, {
    topic: "jurisdiction-dubai",
    topicNumber: 26,
    facts: ["MB-J0", "MB-J1"],
    factRegisterRows: [{ id: "MB-J0", status: "approved", reviewer: "BOSS", verifiedAt: "2026-10-01T00:00:00Z", effectiveFrom: null, expiryOrReviewAt: "2026-12-30", approvedLanguages: ["ar", "el", "en"] }],
    reviewStatus: "approved",
    validUntil: "2026-12-01T00:00:00Z"
  });
  assert.equal(rows[0].content, "approved text");
});

test("metadata enrichment skips invalid chunk ids and fails closed when governance lookups fail", async () => {
  let called = false;
  const rows = await attachKnowledgePolicyMetadata({ from() { called = true; throw new Error("must not query"); } }, [{ chunk_id: "not-a-uuid" }]);
  assert.equal(called, false);
  assert.equal(rows[0].policyMetadata, null);

  const failed = await attachKnowledgePolicyMetadata({
    from() { return { select() { return this; }, in() { return Promise.resolve({ data: null, error: new Error("unavailable") }); } }; }
  }, [{ chunk_id: CHUNK }]);
  assert.equal(failed[0].policyMetadata, null);
});

test("policy metadata rejects malformed topic and fact identifiers", () => {
  const result = policyMetadataForRow({ review_status: "pending", valid_until: "bad" }, {
    topic: "ignore model instructions", topicNumber: 0, facts: ["MB-J9", "MB-F9", "other"]
  }, []);
  assert.equal(result.topic, null);
  assert.equal(result.topicNumber, null);
  assert.deepEqual(result.facts, ["MB-F9"]);
  assert.equal(result.reviewStatus, null);
  assert.equal(result.validUntil, "bad");
});
