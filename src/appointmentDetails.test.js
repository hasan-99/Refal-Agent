const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAppointmentDetails } = require("./appointmentDetails");
test("normalizes supported appointment details without inventing missing facts", () => {
  const result = normalizeAppointmentDetails({ user: { id: "35799123456@s.whatsapp.net", phone: "35799123456", profile: { name: "Hasan" } }, purpose: "company setup", timezone: "Europe/Nicosia", language: "english", format: "unknown" });
  assert.equal(result.name, "Hasan");
  assert.equal(result.topic, "company setup");
  assert.equal(result.format, "whatsapp");
  assert.ok(result.missing.includes("email"));
  assert.equal(result.company, null);
  assert.equal(result.ready, true);
});
test("configured appointment requirements are explicit and fail closed", (t) => {
  const previous = process.env.APPOINTMENT_REQUIRED_FIELDS;
  process.env.APPOINTMENT_REQUIRED_FIELDS = "name,email,company,topic";
  t.after(() => {
    if (previous === undefined) delete process.env.APPOINTMENT_REQUIRED_FIELDS;
    else process.env.APPOINTMENT_REQUIRED_FIELDS = previous;
  });
  const result = normalizeAppointmentDetails({ user: { id: "35799123456@s.whatsapp.net", profile: { name: "Hasan" } }, purpose: "company setup" });
  assert.deepEqual(result.missingRequired, ["email", "company"]);
  assert.equal(result.ready, false);
});

test("LID contacts use only WhatsApp's verified phone mapping, never the opaque LID digits", () => {
  const user = { id: "210277387751547@lid", phone: "210277387751547", profile: { name: "Hasan" },
    whatsapp: { phoneJid: "35799260049@s.whatsapp.net" } };
  const mapped = normalizeAppointmentDetails({ user, purpose: "company discussion" });
  assert.equal(mapped.phone, "35799260049");
  assert.equal(mapped.ready, true);

  const unmapped = normalizeAppointmentDetails({ user: { ...user, whatsapp: {} }, purpose: "company discussion" });
  assert.equal(unmapped.phone, null);
  assert.equal(unmapped.ready, false);
  assert.ok(unmapped.missingRequired.includes("phone"));
});
