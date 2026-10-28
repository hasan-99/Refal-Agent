import test from "node:test";
import assert from "node:assert/strict";
import { shapeDatabaseAuditEvents, shapeLegacyAdminEvents } from "./adminAudit.js";
import { redactAuditEventFields } from "../src/sensitiveData.js";

test("legacy admin audit events omit customer identifiers and accept only safe labels", () => {
  const [event] = shapeLegacyAdminEvents([{
    event: "contact_memory_admin_updated",
    at: "2026-10-13T16:00:00.000Z",
    actor: "admin@example.com",
    action: "updated_memory",
    contactId: "private-contact-id",
    userId: "private-user-id",
    targetId: "private-target-id",
    fields: ["name", "phone", "private field value"]
  }], new Set(["contact_memory_admin_updated"]));

  assert.deepEqual(event, {
    event: "contact_memory_admin_updated",
    at: "2026-10-13T16:00:00.000Z",
    actor: "admin@example.com",
    action: "updated_memory",
    fields: ["name", "phone", "unknown"]
  });
  assert.equal(JSON.stringify(event).includes("private-contact-id"), false);
  assert.equal(JSON.stringify(event).includes("private-user-id"), false);
});

test("business guidance audit rows show reason and changed IDs without exposing prompt content", () => {
  const [event] = shapeLegacyAdminEvents([{
    event: "business_guidance_admin_updated",
    at: "2026-10-14T10:00:00.000Z",
    fields: redactAuditEventFields({
      actor: "admin@example.com",
      guidanceItemCodes: ["rule-booking_followup", "hook-property_intro"],
      reasonCode: "clarify_customer_follow_up",
      guidanceText: "private prompt content"
    })
  }], new Set(["business_guidance_admin_updated"]));

  assert.equal(event.actor, "admin");
  assert.deepEqual(event.fields, [
    "reason: clarify_customer_follow_up",
    "changed items: rule-booking_followup, hook-property_intro"
  ]);
  assert.equal(JSON.stringify(event).includes("private prompt content"), false);
});

test("database audit view keeps safe workflow metadata and redacts private values", () => {
  const [event] = shapeDatabaseAuditEvents([{
    id: "c3ab9604-8f13-4bc6-9bcd-064c277d7da5",
    event: "appointment_reviewed",
    actor_type: "admin",
    source: "dashboard",
    contact_id: "private-contact-id",
    created_at: "2026-10-13T16:00:00.000Z",
    details: { status: "confirmed", action: "reviewed", phone: "+35799123456", message: "private body", targetId: "f1f006f8-9254-4a2d-a604-6ec48d80ef7e" }
  }]);

  assert.deepEqual(event, {
    id: "c3ab9604-8f13-4bc6-9bcd-064c277d7da5",
    event: "appointment_reviewed",
    actorType: "admin",
    source: "dashboard",
    at: "2026-10-13T16:00:00.000Z",
    details: { status: "confirmed", action: "reviewed", phone: "[redacted]", message: "[redacted]", targetId: "[redacted]" }
  });
  assert.equal(Object.hasOwn(event, "contact_id"), false);
});

test("database audit view fails closed on malformed event labels and row details", () => {
  assert.deepEqual(shapeDatabaseAuditEvents([{ event: "Customer Hasan", actor_type: null, source: "bad source", details: "private" }]), [{
    id: "unknown", event: "unknown", actorType: "unknown", source: "unknown", at: "", details: {}
  }]);
});
