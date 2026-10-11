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

test("tell-us requests and common Greek tell imperatives cannot bypass credential or out-of-band code checks", () => {
  for (const text of [
    "Tell us your password.",
    "Could you tell me your account password?",
    "Πείτε μου τον κωδικό πρόσβασής σας.",
    "Πες μου το PIN σου."
  ]) assert.equal(requestsForbiddenCredential(text).violation, true, text);
  assert.ok(requestsForbiddenCredential("Πείτε μου τον κωδικό που σας έστειλε η τράπεζα.").kinds.includes(CREDENTIAL_KINDS.OTP_OUT_OF_BAND));
});

test("an OTP request paired with another identity or account detail is blocked even without naming the issuer", () => {
  for (const text of [
    "Send me the one time password and I will confirm the passport number.",
    "Στείλτε μου τον κωδικό μίας χρήσης και θα επιβεβαιώσω τον αριθμό διαβατηρίου 7741920.",
    "ابعتلي رمز التحقق ورقم الجواز حتى أكد هويتك."
  ]) assert.equal(requestsForbiddenCredential(text).violation, true, text);
});

test("explicit privacy warnings are not mistaken for credential requests", () => {
  for (const text of [
    "For your privacy, please don't send passwords, card details, or account credentials here.",
    "Never share your password or PIN in this chat.",
    "لحماية خصوصيتك، لا تبعت كلمات المرور أو بيانات البطاقات هون.",
    "Για την προστασία σας, μην στείλετε κωδικούς ή στοιχεία κάρτας εδώ."
  ]) assert.equal(requestsForbiddenCredential(text).violation, false, text);
});

test("a later affirmative credential request remains visible after a privacy warning", () => {
  for (const text of [
    "Don't send your password, instead send me your password.",
    "Please don't send your password, send me your PIN here.",
    "ما تبعت كلمة المرور، ابعتلي رقم التعريف الشخصي هون.",
    "Μην στείλετε τον κωδικό πρόσβασης, στείλτε μου τον PIN σας εδώ."
  ]) assert.equal(requestsForbiddenCredential(text).violation, true, text);
});

test("questions asking what a sensitive document contains are not treated as requests to provide it", () => {
  for (const text of [
    "Could you share what a bank statement includes?",
    "Can you explain what a password is?",
    "شو يعني كشف الحساب؟",
    "Τι περιλαμβάνει ένα τραπεζικό αντίγραφο;"
  ]) assert.equal(requestsForbiddenCredential(text).violation, false, text);
  assert.equal(requestsForbiddenCredential("Please send me a bank statement.").violation, true);
});

test("bare credential definitions are informational while possessive requests stay blocked", () => {
  for (const text of [
    "What is a password?",
    "What is a bank statement?",
    "What is the definition of a password?",
    "What is the meaning of a bank statement?",
    "What does a password mean?",
    "Could you tell me what a password is?",
    "Could you tell me what a bank statement includes?",
    "Can you tell me what a bank statement includes?",
    "Tell me what a password is.",
    "شو هي كلمة المرور؟",
    "Ποιο είναι το τραπεζικό αντίγραφο;"
  ]) assert.equal(requestsForbiddenCredential(text).violation, false, text);
  for (const text of [
    "What is your password?",
    "What is the password?",
    "What is the PIN?",
    "شو كلمة مرورك؟",
    "Send me a bank statement.",
    "Στείλτε μου το τραπεζικό αντίγραφο."
  ]) assert.equal(requestsForbiddenCredential(text).violation, true, text);
});

test("a definition cannot exempt a separate credential request later in the reply", () => {
  for (const text of [
    "What is a password? Please send me your password.",
    "What is a bank statement? Please upload the bank statement.",
    "شو هي كلمة المرور؟ ابعتلي كلمة مرورك.",
    "Ποιο είναι το τραπεζικό αντίγραφο; Στείλτε μου το τραπεζικό αντίγραφο.",
    "What is a password, and please send me your password.",
    "Tell me what a password is, and send me your password.",
    "شو هي كلمة المرور، وابعتلي كلمة مرورك.",
    "Ποιο είναι το τραπεζικό αντίγραφο, στείλτε μου το τραπεζικό αντίγραφο."
  ]) assert.equal(requestsForbiddenCredential(text).violation, true, text);
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
