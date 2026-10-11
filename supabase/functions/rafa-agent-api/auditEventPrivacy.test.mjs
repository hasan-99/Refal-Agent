import { test } from "node:test";
import assert from "node:assert/strict";
import { redactAuditEventFields } from "./auditEventPrivacy.mjs";

test("audit event fields redact direct identifiers, free text, nested data, and embedded secrets", () => {
  const result = redactAuditEventFields({
    action: "appointment_admin_rejected",
    contactId: "123456789@s.whatsapp.net",
    reviewer: "operator@example.test",
    reason: "Customer asks for deletion",
    details: [{ state: "failed", providerMessage: "password: SecretPhrase-81; user@example.test" }],
    unclassifiedValue: "كلمة المرور: SecretPhrase-81"
  });
  assert.deepEqual(result, {
    action: "appointment_admin_rejected",
    contactId: "[redacted]",
    reviewer: "[redacted]",
    reason: "[redacted]",
    details: [{ state: "failed", providerMessage: "[redacted]" }],
    unclassifiedValue: "[redacted]"
  });
  assert.doesNotMatch(JSON.stringify(result), /123456789|operator@example|Customer asks|SecretPhrase|user@example/iu);
});

test("audit event sanitization preserves operational fields and handles malformed structures", () => {
  assert.deepEqual(redactAuditEventFields({ id: "a-1", status: "sent", fields: ["status", 2, null] }), {
    id: "a-1", status: "sent", fields: ["status", 2, null]
  });
  assert.deepEqual(redactAuditEventFields({ details: { state: "failed", arbitrary: "Rami Haddad called" } }), {
    details: { state: "failed", arbitrary: "[redacted]" }
  });
});

test("unknown short text is redacted while validated operational metadata survives", () => {
  assert.deepEqual(redactAuditEventFields({
    action: "appointment_admin_rejected", status: "failed", reportDate: "2026-10-11", appointmentId: "a-1",
    details: { note: "Hasan", freeform: "Omar", nested: ["Rami", "safe"] }, fields: ["status", "budget"]
  }), {
    action: "appointment_admin_rejected", status: "failed", reportDate: "2026-10-11", appointmentId: "a-1",
    details: { note: "[redacted]", freeform: "[redacted]", nested: ["[redacted]", "[redacted]"] }, fields: ["status", "budget"]
  });
  assert.deepEqual(redactAuditEventFields({ id: "Hasan", reportDate: "Hasan" }), { id: "[redacted]", reportDate: "[redacted]" });
});

test("Edge audit sanitizer preserves only nonnegative integer provider usage counts from token-named fields", () => {
  assert.deepEqual(redactAuditEventFields({
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
    accessToken: "sk-secret-value-123456",
    apiToken: 42,
    promptTokensInvalid: 2,
    unsafe: "provider/model-a"
  }), {
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
    accessToken: "[redacted]",
    apiToken: "[redacted]",
    promptTokensInvalid: "[redacted]",
    unsafe: "[redacted]"
  });
  for (const value of [-1, 1.5, "120", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(redactAuditEventFields({ promptTokens: value }).promptTokens, "[redacted]");
  }
});
