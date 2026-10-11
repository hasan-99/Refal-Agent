const test = require("node:test");
const assert = require("node:assert/strict");
const { redactSensitiveData, redactAuditEventFields, passesLuhn } = require("./sensitiveData");

test("redacts labeled credentials and leaves unrelated prose intact", () => {
  const input = "My password is SecretPhrase-81. Please explain company setup.";
  const output = redactSensitiveData(input);
  assert.doesNotMatch(output, /SecretPhrase-81/);
  assert.match(output, /Please explain company setup/);
});

test("does not redact plain statements that refuse to share credentials", () => {
  const english = "I can give a case reference, but I won't send a password. Please explain the service.";
  assert.equal(redactSensitiveData(english), english);
  const arabic = "ما رح أشارك كلمة المرور. خبرني عن الخدمة.";
  assert.equal(redactSensitiveData(arabic), arabic);
  const greek = "Δεν θα μοιραστώ κωδικό. Πείτε μου για την υπηρεσία.";
  assert.equal(redactSensitiveData(greek), greek);
});

test("redacts labeled Arabic secrets, API tokens, and valid card numbers", () => {
  const input = "كلمة المرور الوهمية للاختبار FAKE-ONLY-Secret-7241. API token: sk-0123456789abcdefghijklmnop. Card 4111111111111111. البطاقة ٤١١١١١١١١١١١١١١١.";
  const output = redactSensitiveData(input);
  assert.doesNotMatch(output, /FAKE-ONLY|sk-012345|4111111111111111|٤١١١١١١١١١١١١١١١/);
  assert.match(output, /Card \[redacted\]/);
});

test("Luhn validation avoids treating ordinary numbers as card data", () => {
  assert.equal(passesLuhn("4111 1111 1111 1111"), true);
  assert.equal(passesLuhn("1234567890123"), false);
});

test("redacts IBAN and labeled OTP, CVV, passport, ID, and account values", () => {
  const input = "IBAN: CY17 0020 0128 0000 0012 0052 7600; OTP 839102; CVV: 123; passport number: P1234567; national ID: 123456789; account number: 99887766";
  const output = redactSensitiveData(input);
  for (const secret of ["CY17", "839102", "123", "P1234567", "123456789", "99887766"]) assert.equal(output.includes(secret), false, output);
  assert.match(output, /IBAN: \[redacted\]/);
  assert.match(redactSensitiveData("رقم الحساب: 123456789"), /\[redacted\]/);
  assert.match(redactSensitiveData("Αριθμός διαβατηρίου: AB123456"), /\[redacted\]/);
});

test("audit sanitizer redacts unknown short text while retaining validated operational metadata", () => {
  const result = redactAuditEventFields({
    action: "appointment_admin_rejected", status: "failed", reportDate: "2026-10-11", appointmentId: "a-1",
    details: { note: "Hasan", freeform: "Omar", nested: ["Rami", "safe"], trace: "123456789@s.whatsapp.net" },
    fields: ["status", "budget"]
  });
  assert.deepEqual(result, {
    action: "appointment_admin_rejected", status: "failed", reportDate: "2026-10-11", appointmentId: "a-1",
    details: { note: "[redacted]", freeform: "[redacted]", nested: ["[redacted]", "[redacted]"], trace: "[redacted]" },
    fields: ["status", "budget"]
  });
  assert.deepEqual(redactAuditEventFields({ id: "Hasan", reportDate: "Hasan" }), { id: "[redacted]", reportDate: "[redacted]" });
});

test("audit sanitizer preserves only nonnegative integer provider usage counts from token-named fields", () => {
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
