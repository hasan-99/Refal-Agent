const test = require("node:test");
const assert = require("node:assert/strict");
const { EVENTS, STATES, canDiscloseAccountInformation, initialExistingClientState, transitionExistingClientState } = require("./existingClientWorkflow");

test("existing-client authentication transitions require a trusted verification result", () => {
  let state = transitionExistingClientState(initialExistingClientState(), EVENTS.detect);
  assert.equal(state.state, STATES.awaiting_identifier);
  state = transitionExistingClientState(state, EVENTS.identifier_provided, { identifier: "client-123" });
  assert.equal(state.state, STATES.awaiting_verification);
  state = transitionExistingClientState(state, EVENTS.verification_passed, { verified: false });
  assert.equal(state.state, STATES.awaiting_verification);
  state = transitionExistingClientState(state, EVENTS.verification_passed, { verified: true });
  assert.equal(state.state, STATES.authenticated);
  assert.equal(canDiscloseAccountInformation(state), true);
});

test("three failed attempts lock the state and prevent account disclosure", () => {
  let state = transitionExistingClientState(initialExistingClientState(), EVENTS.detect);
  state = transitionExistingClientState(state, EVENTS.identifier_provided, { identifier: "client-123" });
  for (let i = 0; i < 3; i++) {
    state = transitionExistingClientState(state, EVENTS.verification_failed);
    if (i < 2) state = transitionExistingClientState(state, EVENTS.identifier_provided, { identifier: "client-123" });
  }
  assert.equal(state.state, STATES.locked);
  assert.equal(canDiscloseAccountInformation(state), false);
});

// ---------------------------------------------------------------------------
// P2.5 / W2.5.5 — existing client verification, built not parked.
// Appended additively. The two tests above are the pre-P2.5 suite and must keep
// passing with their original signatures.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_ATTEMPTS,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_TTL_MS,
  beginExistingClientFlow,
  existingClientVerificationPrompt,
  issueVerificationCode,
  submitVerificationCode,
  applySelfAssertedIdentity,
  canDiscloseAccountInformationInConversation,
  resolveOnFileContact,
  maskContact,
  setVerificationCodeSender
} = require("./existingClientWorkflow");

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const ACCOUNT = Object.freeze({ contactsOnFile: [{ channel: "sms", value: "+35799123456", onFile: true }] });

// Captures what the injected delivery function was handed. This is the only
// place the plaintext code is ever visible, which is exactly the point.
function capturingSender() {
  const seen = [];
  const send = (payload) => { seen.push(payload); return { delivered: true }; };
  send.seen = seen;
  send.lastCode = () => seen[seen.length - 1].code;
  return send;
}

function issued(options = {}) {
  const sendCode = capturingSender();
  const result = issueVerificationCode(beginExistingClientFlow(), {
    accountRecord: ACCOUNT, sendCode, now: T0, conversationId: "conv-A", language: "english", ...options
  });
  return { result, sendCode, code: sendCode.seen.length ? sendCode.lastCode() : null };
}

test("a self-asserted detail alone never authenticates, even when the caller number matches", () => {
  let state = beginExistingClientFlow();
  state = transitionExistingClientState(state, EVENTS.identifier_provided, { identifier: "I am Maria Georgiou, account 55512" });
  state = applySelfAssertedIdentity(state, {
    claimedName: "Maria Georgiou",
    claimedAccountNumber: "55512",
    callerNumberMatchesFile: true
  });
  assert.equal(state.authenticated, false);
  assert.equal(state.accountDisclosureAllowed, false);
  assert.equal(canDiscloseAccountInformation(state), false);
  assert.equal(state.state === STATES.authenticated, false);
  // The claimed values are personal data with no authentication worth, so none
  // of them are stored.
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("Maria Georgiou"), "a claimed name was stored");
  assert.ok(!serialized.includes("55512"), "a claimed account number was stored");
});

test("a self-asserted identity cannot bypass the code even after many turns", () => {
  let state = beginExistingClientFlow();
  for (let turn = 0; turn < 5; turn += 1) {
    state = applySelfAssertedIdentity(state, { callerNumberMatchesFile: true });
    assert.equal(canDiscloseAccountInformation(state), false, `turn ${turn}`);
  }
});

test("a correct code sent to the on-file contact authenticates for that conversation", () => {
  const { result, code } = issued();
  assert.equal(result.ok, true);
  assert.equal(result.state.state, STATES.awaiting_verification);
  assert.equal(canDiscloseAccountInformation(result.state), false);

  const verified = submitVerificationCode(result.state, code, { now: T0 + 30000 });
  assert.equal(verified.ok, true);
  assert.equal(verified.state.state, STATES.authenticated);
  assert.equal(canDiscloseAccountInformation(verified.state), true);
  assert.equal(canDiscloseAccountInformationInConversation(verified.state, "conv-A"), true);
  // Unlocked for THAT conversation only.
  assert.equal(canDiscloseAccountInformationInConversation(verified.state, "conv-B"), false);
});

test("the code goes only to the contact on file, never to a detail from the conversation", () => {
  const sendCode = capturingSender();
  issueVerificationCode(beginExistingClientFlow(), {
    accountRecord: ACCOUNT,
    // A caller passing a number the customer typed cannot reach the sender:
    // there is no parameter that carries it through.
    customerSuppliedContact: { channel: "sms", value: "+971500000000" },
    sendCode, now: T0
  });
  assert.equal(sendCode.seen.length, 1);
  assert.equal(sendCode.seen[0].to, "+35799123456");
  assert.equal(sendCode.seen[0].channel, "sms");

  // A contact marked as not on file is skipped entirely.
  assert.equal(resolveOnFileContact({ contactsOnFile: [{ channel: "sms", value: "+971500000000", onFile: false }] }), null);
  const refused = issueVerificationCode(beginExistingClientFlow(), {
    accountRecord: { contactsOnFile: [{ channel: "sms", value: "+971500000000", onFile: false }] },
    customerSuppliedContact: { channel: "sms", value: "+971500000000" },
    sendCode, now: T0
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "no_contact_on_file");
  assert.equal(sendCode.seen.length, 1, "a code was sent to a contact that is not on file");
});

test("the plaintext code never reaches the state, the customer message, or any return value", () => {
  const { result, code } = issued();
  assert.equal(code.length, VERIFICATION_CODE_LENGTH);
  assert.match(code, /^\d{6}$/u);
  assert.ok(!JSON.stringify(result.state).includes(code), "the code is in the state object");
  assert.ok(!result.customerMessage.includes(code), "the code is in the customer message");
  assert.ok(!JSON.stringify({ ...result, state: undefined }).includes(code), "the code is in a returned field");
  // What IS stored is a salted hash plus a masked hint, never the contact itself.
  assert.match(result.state.verification.codeHash, /^[0-9a-f]{64}$/u);
  assert.ok(result.state.verification.salt.length >= 16);
  assert.ok(!JSON.stringify(result.state).includes("+35799123456"), "the full contact is in the state");
  assert.equal(result.contactHint, "•••3456");
});

test("the module generates codes with node:crypto, never Math.random", () => {
  const source = fs.readFileSync(path.join(__dirname, "existingClientWorkflow.js"), "utf8");
  // The call form, not the bare words, so the warning comment in the module
  // explaining why it is banned does not trip its own guard.
  assert.doesNotMatch(source, /Math\s*\.\s*random\s*\(/u, "a predictable PRNG must never mint an auth secret");
  assert.ok(source.includes("crypto.randomInt"), "the code must come from node:crypto randomInt");
  assert.ok(source.includes("timingSafeEqual"), "the comparison must be constant time");
});

test("an expired code does not authenticate", () => {
  const { result, code } = issued();
  const late = submitVerificationCode(result.state, code, { now: T0 + VERIFICATION_CODE_TTL_MS + 1 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "expired");
  assert.equal(canDiscloseAccountInformation(late.state), false);
  // The record is closed, so the same digits cannot be retried.
  const retry = submitVerificationCode(late.state, code, { now: T0 + VERIFICATION_CODE_TTL_MS + 2 });
  assert.equal(retry.ok, false);
  assert.equal(canDiscloseAccountInformation(retry.state), false);
});

test("a code is single use, so a second presentation does not authenticate", () => {
  const { result, code } = issued();
  const verified = submitVerificationCode(result.state, code, { now: T0 + 1000 });
  assert.equal(verified.ok, true);
  assert.equal(verified.state.verification.consumed, true);
  assert.equal(verified.state.verification.codeHash, undefined, "the hash survived a successful verification");

  // Replay the same digits against a state put back into the verification step.
  const replayed = { ...verified.state, state: STATES.awaiting_verification, authenticated: false, accountDisclosureAllowed: false };
  const reuse = submitVerificationCode(replayed, code, { now: T0 + 2000 });
  assert.equal(reuse.ok, false);
  assert.equal(reuse.reason, "code_already_used");
  assert.equal(canDiscloseAccountInformation(reuse.state), false);
});

test("three wrong codes lock the conversation, reusing MAX_ATTEMPTS", () => {
  const { result, code } = issued();
  const wrong = String((Number(code) + 1) % 10 ** VERIFICATION_CODE_LENGTH).padStart(VERIFICATION_CODE_LENGTH, "0");
  assert.notEqual(wrong, code);

  let state = result.state;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = submitVerificationCode(state, wrong, { now: T0 + attempt * 1000 });
    assert.equal(response.ok, false, `attempt ${attempt}`);
    state = response.state;
    assert.equal(state.attempts, attempt, `attempt ${attempt}`);
  }
  assert.equal(state.state, STATES.locked);
  assert.equal(canDiscloseAccountInformation(state), false);

  // A locked conversation cannot be given a fresh code either.
  const reissue = issueVerificationCode(state, { accountRecord: ACCOUNT, sendCode: capturingSender(), now: T0 + 9000 });
  assert.equal(reissue.ok, false);
  assert.equal(reissue.reason, "locked");

  // And the correct code no longer helps once locked.
  const late = submitVerificationCode(state, code, { now: T0 + 9000 });
  assert.equal(late.ok, false);
  assert.equal(canDiscloseAccountInformation(late.state), false);
});

test("a wrong attempt leaves the remaining attempts usable on the same code", () => {
  const { result, code } = issued();
  const wrong = String((Number(code) + 7) % 10 ** VERIFICATION_CODE_LENGTH).padStart(VERIFICATION_CODE_LENGTH, "0");
  const first = submitVerificationCode(result.state, wrong, { now: T0 + 1000 });
  assert.equal(first.ok, false);
  assert.equal(first.state.state, STATES.failed);
  const second = submitVerificationCode(first.state, code, { now: T0 + 2000 });
  assert.equal(second.ok, true);
  assert.equal(canDiscloseAccountInformation(second.state), true);
});

test("a blank, wrong-length, or non-numeric answer is rejected without throwing", () => {
  const { result } = issued();
  for (const answer of [null, undefined, "", "   ", "abcdef", "12345", "1234567"]) {
    const response = submitVerificationCode(result.state, answer, { now: T0 + 1000 });
    assert.equal(response.ok, false, String(answer));
    assert.equal(canDiscloseAccountInformation(response.state), false, String(answer));
  }
});

test("submitting a code with no issued verification is refused", () => {
  const response = submitVerificationCode(beginExistingClientFlow(), "123456", { now: T0 });
  assert.equal(response.ok, false);
  assert.equal(response.reason, "not_awaiting_verification");
  assert.equal(canDiscloseAccountInformation(response.state), false);
});

test("the mechanism has a working default and routes to an approved channel when no sender is registered", () => {
  // G6. Nothing is parked: with no sender configured the flow still runs and
  // the customer gets a real next step rather than a dead end.
  const fallback = issueVerificationCode(beginExistingClientFlow(), { accountRecord: ACCOUNT, now: T0 });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.reason, "verification_sender_not_configured");
  assert.match(fallback.customerMessage, /approved channel/iu);

  // The single field BOSS fills. It is a function, so no credential lives here.
  try {
    setVerificationCodeSender(() => ({ delivered: true }));
    const live = issueVerificationCode(beginExistingClientFlow(), { accountRecord: ACCOUNT, now: T0 });
    assert.equal(live.ok, true);
  } finally {
    setVerificationCodeSender(null);
  }

  // A sender that throws degrades to the same safe path.
  const thrower = () => { throw new Error("transport down"); };
  const broken = issueVerificationCode(beginExistingClientFlow(), { accountRecord: ACCOUNT, sendCode: thrower, now: T0 });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "delivery_failed");
});

test("the verification prompt is trilingual, hides the contact, and uses no dash connector", () => {
  for (const language of ["english", "arabic", "greek"]) {
    const prompt = existingClientVerificationPrompt(language, { contactHint: "•••3456" });
    assert.ok(prompt.includes("•••3456"), language);
    assert.ok(!prompt.includes("+35799123456"), language);
    assert.doesNotMatch(prompt, /\s[-–—]\s/u, language);
  }
  assert.equal(
    existingClientVerificationPrompt("klingon", { contactHint: "x" }),
    existingClientVerificationPrompt("english", { contactHint: "x" })
  );
});

test("contact hints never expose the full value", () => {
  assert.equal(maskContact({ channel: "sms", value: "+35799123456" }), "•••3456");
  assert.equal(maskContact({ channel: "whatsapp", value: "+35799123456" }), "•••3456");
  assert.equal(maskContact({ channel: "email", value: "maria@example.com" }), "m•••@example.com");
  assert.equal(maskContact({ channel: "sms", value: "12" }), "•••");
  assert.equal(maskContact(null), "");
});

test("null, empty, and undefined input are safe across the new entry points", () => {
  assert.equal(resolveOnFileContact(null), null);
  assert.equal(resolveOnFileContact(undefined), null);
  assert.equal(resolveOnFileContact({}), null);
  assert.equal(resolveOnFileContact({ contactsOnFile: [null, {}, { channel: "pigeon", value: "x" }, { channel: "sms", value: "" }] }), null);
  assert.equal(issueVerificationCode(undefined, {}).ok, false);
  assert.equal(submitVerificationCode(undefined, undefined, {}).ok, false);
  assert.equal(canDiscloseAccountInformationInConversation(null, "conv-A"), false);
  assert.equal(canDiscloseAccountInformationInConversation(undefined, undefined), false);
  assert.equal(applySelfAssertedIdentity(undefined, undefined).authenticated, false);
});
