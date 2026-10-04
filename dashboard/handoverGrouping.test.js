import test from "node:test";
import assert from "node:assert/strict";
import { countUniqueHandoverContacts, groupHandoversByContact } from "./handoverGrouping.js";

test("active handovers from one contact appear as one group while retaining their records", () => {
  const grouped = groupHandoversByContact([
    { id: "newer", status: "open", priority: "normal", contact: { id: "contact-1", name: "Customer" }, drafts: [{ id: "draft-1" }], alerts: [{ id: "alert-1" }] },
    { id: "older", status: "acknowledged", priority: "high", contact: { id: "contact-1", name: "Customer" }, drafts: [{ id: "draft-2" }], alerts: [{ id: "alert-2" }] },
    { id: "other", status: "open", priority: "normal", contact: { id: "contact-2", name: "Another" } }
  ]);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].groupCount, 2);
  assert.deepEqual(grouped[0].handoverIds, ["newer", "older"]);
  assert.equal(grouped[0].id, "newer");
  assert.equal(grouped[0].status, "open");
  assert.equal(grouped[0].priority, "high");
  assert.deepEqual(grouped[0].drafts.map((item) => item.id), ["draft-1", "draft-2"]);
  assert.deepEqual(grouped[0].alerts.map((item) => item.id), ["alert-1", "alert-2"]);
});

test("records without contact identity remain separate and malformed input is safe", () => {
  const grouped = groupHandoversByContact([{ id: "one" }, { id: "two" }]);
  assert.equal(grouped.length, 2);
  assert.equal(groupHandoversByContact(null).length, 0);
});

test("follow-up badge counts one contact once across multiple active handovers", () => {
  assert.equal(countUniqueHandoverContacts([
    { id: "newer", contact_id: "contact-1" },
    { id: "older", contact_id: "contact-1" },
    { id: "other", contact_id: "contact-2" }
  ]), 2);
  assert.equal(countUniqueHandoverContacts([{ id: "one" }, { id: "two" }]), 2);
  assert.equal(countUniqueHandoverContacts(null), 0);
});

test("one canonical handover still indicates how many historical requests were merged", () => {
  const [group] = groupHandoversByContact([{
    id: "canonical",
    contact: { id: "contact-1" },
    summary: { relatedRequests: [{}, {}, {}] }
  }]);
  assert.equal(group.groupCount, 3);
});
