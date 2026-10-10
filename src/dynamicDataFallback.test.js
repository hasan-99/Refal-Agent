"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requestDynamicKinds, collectDynamicFallback, applyDynamicPrecedence } = require("./dynamicDataFallback");

function offer(overrides = {}) {
  const now = Date.now();
  return {
    code: "formation-package", title_en: "Company formation package", title_ar: "باقة تأسيس شركة", title_el: "Πακέτο σύστασης εταιρείας",
    amount: 999, currency: "EUR", vat_note: "plus VAT", inclusions: ["Incorporation"],
    eligibility: null,
    active: true, review_status: "approved", effective_from: new Date(now - 86400000).toISOString(),
    valid_until: new Date(now + 86400000).toISOString(), verified_at: new Date(now - 86400000).toISOString(),
    updated_at: new Date(now - 3600000).toISOString(), ...overrides
  };
}

test("formation questions select the approved live offer and never trust stale knowledge over it", async () => {
  const queries = [];
  const dynamic = await collectDynamicFallback({
    async lookupDynamicData(kind, args) {
      queries.push({ kind, args });
      return { ok: true, status: "available", data: [offer()] };
    }
  }, "What is the current company formation package price?");
  assert.deepEqual(queries, [{ kind: "offers", args: { code: "formation-package" } }]);
  assert.equal(dynamic.statuses[0].status, "found");
  assert.match(dynamic.live[0].content, /amount: EUR 999/);
  const old = { chunk_id: "old", content: "The company formation package price is EUR 899.", valid_until: "2027-01-01T00:00:00Z" };
  const result = applyDynamicPrecedence([old], dynamic.live, ["offers"]);
  assert.deepEqual(result.evidence.map((row) => row._dynamicKind), ["offers"]);
  assert.deepEqual(result.decisions, ["precedence:live_data_over_knowledge"]);
});

test("empty, stale, and unauthorized commercial rows cannot rescue frozen figures", async () => {
  const dynamic = await collectDynamicFallback({
    async lookupDynamicData() {
      return { ok: true, status: "unavailable", data: [offer({ valid_until: "2020-01-01T00:00:00Z" }), offer({ review_status: "draft" })] };
    }
  }, "How much is company formation?");
  assert.equal(dynamic.live.length, 0);
  assert.equal(dynamic.statuses[0].status, "unavailable");
  const old = { chunk_id: "old", content: "The company formation package price is EUR 899." };
  assert.deepEqual(applyDynamicPrecedence([old], dynamic.live, ["offers"]).evidence, []);
});

test("failed and malformed gateway statuses never expose a payload as current data", async () => {
  for (const response of [
    { ok: false, status: "error", data: [offer()] },
    { ok: true, status: "error", data: [offer()] },
    { ok: true, status: "unavailable", data: [offer()] }
  ]) {
    const result = await collectDynamicFallback({ async lookupDynamicData() { return response; } }, "How much is company formation?");
    assert.equal(result.live.length, 0);
    assert.notEqual(result.statuses[0].status, "found");
  }
});

test("ambiguous dynamic pricing questions fail closed and do not expose retrieved prices", () => {
  assert.deepEqual(requestDynamicKinds("What are your prices?"), []);
  const old = { chunk_id: "old", content: "The package costs EUR 999." };
  assert.deepEqual(applyDynamicPrecedence([old], [], [], { failClosed: true }).evidence, []);
});

test("live precedence can suppress a stale chunk when only its document reference is present", () => {
  const live = { ...require("./dynamicDataFallback").dynamicEvidence("offers", offer()) };
  const stale = { document_id: "stale-doc", content: "Company formation offer EUR 899." };
  const result = applyDynamicPrecedence([stale], [live], ["offers"]);
  assert.deepEqual(result.evidence.map((row) => row._dynamicKind), ["offers"]);
});

test("noncommercial questions do not query dynamic tables", async () => {
  assert.deepEqual(requestDynamicKinds("What services do you provide?"), []);
  let called = false;
  const result = await collectDynamicFallback({ async lookupDynamicData() { called = true; } }, "What services do you provide?");
  assert.equal(called, false);
  assert.deepEqual(result.statuses, []);
});
