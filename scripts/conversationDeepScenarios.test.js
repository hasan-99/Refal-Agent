const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDeepConversationCases } = require("./conversationDeepScenarios");

test("the live deep conversation corpus has 3,000 distinct 8-turn conversations across 51 scenario families", () => {
  const cases = buildDeepConversationCases(3000);
  assert.equal(cases.length, 3000);
  assert.equal(new Set(cases.map((item) => item.id)).size, 3000);
  assert.deepEqual(cases.reduce((counts, item) => ({ ...counts, [item.locale]: (counts[item.locale] || 0) + 1 }), {}), { en: 1000, ar: 1000, el: 1000 });
  assert.equal(new Set(cases.map((item) => item.scenario)).size, 51);
  assert.ok(cases.every((item) => item.messages.length === 8));
  assert.ok(cases.every((item) => item.messages.every((message) => typeof message === "string" && message.length > 0)));
});

test("deep scenarios progressively test corrections, claims, client boundaries, and memory", () => {
  const cases = buildDeepConversationCases(3000);
  assert.ok(cases.some((item) => item.depthGroup === "formation" && /correct|clarify|clarification|تصحيح|للتوضيح|διευκρ/i.test(item.messages[3])));
  assert.ok(cases.some((item) => /guarantee|guaranteed|مضمون|بتضمن|εγγυ/i.test(item.messages[5])));
  assert.ok(cases.some((item) => /not ready|ما بدي|δεν θέλω/i.test(item.messages[6])));
  assert.ok(cases.every((item) => /recap|summar|ملخص|لخّص|σύνοψη|Συνοψ/i.test(item.messages[7])));
});

test("deep corpus assigns stable deterministic persona seeds and varied response behaviors", () => {
  const first = buildDeepConversationCases(3000);
  const second = buildDeepConversationCases(3000);
  assert.deepEqual(first.map(({ id, seed, persona, responseBeats }) => ({ id, seed, persona, responseBeats })), second.map(({ id, seed, persona, responseBeats }) => ({ id, seed, persona, responseBeats })));
  assert.equal(new Set(first.map((item) => item.seed)).size, 3000);
  assert.ok(new Set(first.map((item) => item.persona.id)).size >= 6);
  assert.ok(first.every((item) => item.responseBeats.length === 5));
  assert.ok(first.every((item) => item.persona.instruction.length > 0));
});

test("deep corpus size is bounded at 3,000 and returned messages are isolated from the source cases", () => {
  const cases = buildDeepConversationCases(9000);
  assert.equal(cases.length, 3000);
  cases[0].messages[0] = "mutated only in the deep corpus";
  assert.notEqual(buildDeepConversationCases(1)[0].messages[0], "mutated only in the deep corpus");
});

test("synthetic sensitive-data probes stay local-only and include IBAN, OTP, CVV, and passport cases", () => {
  const probes = buildDeepConversationCases(3000).filter((item) => item.scenario === "secret_data");
  assert.ok(probes.length >= 5);
  assert.ok(probes.every((item) => item.localOnly === true));
  assert.ok(probes.every((item) => /CY00 0000 0000 0000 0000 0000 0000/u.test(item.messages[3]) && /OTP 123456/u.test(item.messages[3]) && /CVV 123/u.test(item.messages[3]) && /FAKE-ONLY-PASSPORT/u.test(item.messages[3])));
});
