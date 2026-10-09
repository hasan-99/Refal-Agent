const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CREDENTIAL_KINDS, requestsForbiddenCredential, safePrivacyRedirect } = require("./privacyHardRule");
const { SAFETY_CATEGORIES, detectSafetyRisks, FALLBACKS } = require("./safetyPolicy");
const { existingClientVerificationPrompt } = require("./existingClientWorkflow");

// P2.5 / W2.5.4 (MB-SEC4). The OUTBOUND direction only; safetyPolicy's PRIVACY
// category keeps the inbound direction and is asserted here to prove the two
// gates remain distinct rather than duplicated.

test("an outbound request for a password is caught in English, Arabic, and Greek", () => {
  const cases = [
    ["Please send me your password so I can check the account", "english"],
    ["أرسل لي كلمة المرور من فضلك حتى أتحقق من الحساب", "arabic"],
    ["Στείλτε μου τον κωδικό πρόσβασής σας για να ελέγξω τον λογαριασμό", "greek"]
  ];
  for (const [text, language] of cases) {
    const result = requestsForbiddenCredential(text);
    assert.equal(result.violation, true, text);
    assert.ok(result.kinds.includes(CREDENTIAL_KINDS.PASSWORD), text);
    assert.equal(result.language, language, text);
  }
});

test("an outbound request for card data is caught in all three languages", () => {
  for (const text of [
    "Please provide your card number and the CVV on the back",
    "زودني برقم البطاقة وبيانات البطاقة من فضلك",
    "Δώστε μου τον αριθμό κάρτας και το CVV"
  ]) {
    assert.ok(requestsForbiddenCredential(text).kinds.includes(CREDENTIAL_KINDS.CARD_DATA), text);
  }
});

test("an outbound request for a bank statement is caught in all three languages", () => {
  for (const text of [
    "Can you upload your bank statement here so I can review it?",
    "أرسل كشف الحساب هون لأراجعه",
    "Ανεβάστε εδώ το τραπεζικό αντίγραφο για να το δω"
  ]) {
    assert.ok(requestsForbiddenCredential(text).kinds.includes(CREDENTIAL_KINDS.BANK_STATEMENT), text);
  }
});

test("an outbound request for a PIN or banking credentials is caught", () => {
  assert.ok(requestsForbiddenCredential("Please type your PIN here").kinds.includes(CREDENTIAL_KINDS.PIN));
  assert.ok(requestsForbiddenCredential("Δώστε μου το PIN σας").kinds.includes(CREDENTIAL_KINDS.PIN));
  assert.ok(requestsForbiddenCredential("Send me your online banking login").kinds.includes(CREDENTIAL_KINDS.BANKING_CREDENTIALS));
});

test("asking the customer to forward a code another institution sent is an out of band OTP request", () => {
  for (const text of [
    "Please forward the OTP your bank sent you",
    "أرسل لي رمز التحقق اللي وصلك من البنك",
    "Στείλτε μου τον κωδικό επαλήθευσης που σας έστειλε η τράπεζα"
  ]) {
    assert.ok(requestsForbiddenCredential(text).kinds.includes(CREDENTIAL_KINDS.OTP_OUT_OF_BAND), text);
  }
});

test("REFAL's own verification prompt is not a forbidden credential request", () => {
  // W2.5.5 issues a code to the contact already on file and asks for it back.
  // That is the approved mechanism, not the phishing pattern MB-SEC4 bans, so
  // the two must not collide. If this ever fails, the hard rule has started
  // blocking the only working authentication path.
  for (const language of ["english", "arabic", "greek"]) {
    const prompt = existingClientVerificationPrompt(language, { contactHint: "•••3456" });
    assert.equal(requestsForbiddenCredential(prompt).violation, false, language);
  }
});

test("ordinary wording does not false positive (BLK-15 class)", () => {
  for (const text of [
    "I can explain what a bank statement is and why banks ask for one",
    "Our fee covers the company formation package",
    "The password reset is handled by the bank itself",
    "We can activate your account once the documents are complete",
    "بقدر أشرحلك شو يعني كشف الحساب وليش البنوك بتطلبه",
    "Μπορώ να εξηγήσω τι είναι ένα τραπεζικό αντίγραφο"
  ]) {
    assert.equal(requestsForbiddenCredential(text).violation, false, text);
  }
});

test("null, empty, and undefined input are safe", () => {
  for (const text of [null, undefined, "", "   "]) {
    const result = requestsForbiddenCredential(text);
    assert.equal(result.violation, false);
    assert.deepEqual(result.kinds, []);
    assert.equal(typeof result.language, "string");
  }
});

test("Arabic bare-alef and hamza spellings reach the same verdict (BLK-16)", () => {
  const pairs = [
    ["ارسل لي كلمه المرور", "أرسل لي كلمة المرور"],
    ["ارسل كشف الحساب", "أرسل كشف الحساب"],
    ["اعطني رقم البطاقه", "أعطني رقم البطاقة"]
  ];
  for (const [bare, pointed] of pairs) {
    assert.deepEqual(requestsForbiddenCredential(bare).kinds, requestsForbiddenCredential(pointed).kinds, `variant mismatch: ${bare}`);
    assert.equal(requestsForbiddenCredential(bare).violation, true, `bare-alef spelling bypassed the gate: ${bare}`);
  }
});

test("the redirect reuses the approved secure-channel wording from safetyPolicy", () => {
  for (const language of ["english", "arabic", "greek"]) {
    assert.equal(safePrivacyRedirect(language), FALLBACKS[language].privacy);
    assert.doesNotMatch(safePrivacyRedirect(language), /\s[-–—]\s/u, language);
  }
  assert.equal(safePrivacyRedirect("klingon"), FALLBACKS.english.privacy);
  assert.equal(safePrivacyRedirect(undefined), FALLBACKS.english.privacy);
});

test("the inbound privacy gate is untouched and remains a separate direction", () => {
  // Inbound: the customer disclosing. Still handled by safetyPolicy.
  assert.ok(detectSafetyRisks("My password is SecretPhrase-81.").includes(SAFETY_CATEGORIES.PRIVACY));
  // Outbound: REFAL asking. Not something the inbound classifier is asked about.
  assert.equal(requestsForbiddenCredential("My password is SecretPhrase-81.").violation, false);
});
