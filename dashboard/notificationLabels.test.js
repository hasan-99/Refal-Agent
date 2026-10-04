import test from "node:test";
import assert from "node:assert/strict";
import { notificationJobLabel } from "./notificationLabels.js";

test("notification issues are labeled by purpose and actual delivery channel", () => {
  assert.equal(notificationJobLabel({ kind: "owner_review", channel: "email" }), "Admin email");
  assert.equal(notificationJobLabel({ kind: "handover_review", channel: "email" }), "Admin handover email");
  assert.equal(notificationJobLabel({ kind: "admin_followup", channel: "whatsapp" }), "Admin follow-up WhatsApp");
  assert.equal(notificationJobLabel({ kind: "admin_followup", channel: "email" }), "Admin follow-up email");
  assert.equal(notificationJobLabel({ kind: "customer_message", channel: "email" }), "Customer email");
});
