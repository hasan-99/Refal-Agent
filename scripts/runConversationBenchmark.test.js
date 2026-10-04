const test = require("node:test");
const assert = require("node:assert/strict");
const { BenchmarkStore, assessTurn, safeBenchmarkErrorCategory } = require("./runConversationBenchmark");
const { CUSTOMER_BOOKING_URL } = require("../src/booking");

test("benchmark persistence applies the same credential and payment redaction as production stores", async () => {
  const store = new BenchmarkStore("benchmark:redaction-test");
  await store.addHistory(store.user.id, "Password: FakePass-7241", "A card was 4111111111111111.");
  const saved = JSON.stringify(store.user.history);
  assert.doesNotMatch(saved, /FakePass-7241|4111111111111111/);
});

test("benchmark trace error summaries retain safe categories without provider details", () => {
  const quota = safeBenchmarkErrorCategory(Object.assign(new Error("Key limit exceeded; manage at https://openrouter.ai/workspaces/default/keys/secret-id"), { status: 403 }));
  assert.equal(quota, "http_403");
  assert.doesNotMatch(quota, /openrouter|secret-id|https?:/iu);
  assert.equal(safeBenchmarkErrorCategory(new Error("OpenRouter returned an answer in the wrong customer language")), "wrong_language");
  assert.equal(safeBenchmarkErrorCategory(new Error("database access token: private"), "retrieval"), "retrieval_failed");
});

function check({ incoming, response, locale = "en", allowLanguageSwitch = false }) {
  const store = new BenchmarkStore("benchmark:assessment-test");
  store.user.history.push({ id: "turn-1", message: incoming, response, metadata: {} });
  return assessTurn({ incoming, response, language: locale, allowLanguageSwitch, evidence: [], route: null, store, localOnly: false });
}

test("conversation assessment expects the language of the customer's current turn", () => {
  const result = check({ incoming: "تمام، شكراً.", response: "العفو، أنا هون إذا احتجت أي مساعدة." });
  assert.equal(result.detectedLanguage, "arabic");
  assert.equal(result.findings.some((finding) => finding.startsWith("response_language_mismatch:")), false);
});

test("conversation assessment still flags a reply that ignores the current turn language", () => {
  const result = check({ incoming: "Καλημέρα, τι υπηρεσίες προσφέρετε;", response: "I can help with approved information about the services." });
  assert.ok(result.findings.includes("response_language_mismatch:english"));
});

test("conversation assessment allows an explicit request to switch languages", () => {
  const result = check({ incoming: "Μπορούμε να συνεχίσουμε στα ελληνικά;", response: "Φυσικά, συνεχίζουμε στα ελληνικά.", allowLanguageSwitch: true });
  assert.equal(result.findings.some((finding) => finding.startsWith("response_language_mismatch:")), false);
});

test("conversation assessment accepts consent linked to an earlier offer turn", () => {
  const store = new BenchmarkStore("benchmark:assessment-consent");
  store.user.history.push({ id: "offer-yes", message: "Yes, please.", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up", trackedOffer: true } } });
  store.user.history.push({ id: "latest", message: "My name is Mira.", metadata: {} });
  store.effects.consentEvents.push({ state: "granted", sourceTurnId: "offer-yes" });
  const result = assessTurn({ incoming: "My name is Mira.", response: "Thanks, I have noted the name.", language: "en", allowLanguageSwitch: false, evidence: [], route: null, store, localOnly: false });
  assert.equal(result.findings.includes("possible_untracked_consent"), false);
});

test("the configured public appointment link is not reported as an unapproved URL", () => {
  const result = check({ incoming: "Can I book a meeting?", response: `Choose a time here: ${CUSTOMER_BOOKING_URL}` });
  assert.equal(result.findings.includes("customer_facing_url"), false);
});

test("an uncertain registration recap is not classified as a promised outcome", () => {
  const result = check({ incoming: "What did you understand?", response: "You are unsure whether the company is already registered in Cyprus." });
  assert.equal(result.findings.includes("unverified_outcome_claim"), false);
});

test("an unsupported registration claim remains classified as an outcome claim", () => {
  const result = check({ incoming: "What did you understand?", response: "The company is already registered in Cyprus." });
  assert.ok(result.findings.includes("unverified_outcome_claim"));
});
