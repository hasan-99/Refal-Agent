const crypto = require("node:crypto");
const { localizedLanguage } = require("./language");

const STATES = Object.freeze({ unauthenticated: "unauthenticated", awaiting_identifier: "awaiting_identifier", awaiting_verification: "awaiting_verification", authenticated: "authenticated", failed: "failed", locked: "locked" });
const EVENTS = Object.freeze({ detect: "detect", identifier_provided: "identifier_provided", verification_requested: "verification_requested", verification_passed: "verification_passed", verification_failed: "verification_failed", reset: "reset", logout: "logout" });
const MAX_ATTEMPTS = 3;

function initialExistingClientState() { return { state: STATES.unauthenticated, attempts: 0, authenticated: false, accountDisclosureAllowed: false }; }

function beginExistingClientFlow() { return transitionExistingClientState(initialExistingClientState(), EVENTS.detect); }

function transitionExistingClientState(current = initialExistingClientState(), event, data = {}) {
  const state = { ...initialExistingClientState(), ...current };
  if (event === EVENTS.reset || event === EVENTS.logout) return initialExistingClientState();
  if (event === EVENTS.detect && [STATES.unauthenticated, STATES.failed].includes(state.state)) return { ...state, state: STATES.awaiting_identifier };
  if (event === EVENTS.identifier_provided && [STATES.awaiting_identifier, STATES.failed].includes(state.state) && String(data.identifier || "").trim()) return { ...state, state: STATES.awaiting_verification, identifierProvided: true };
  if (event === EVENTS.verification_requested && state.state === STATES.awaiting_identifier) return { ...state, state: STATES.awaiting_verification };
  if (event === EVENTS.verification_passed && state.state === STATES.awaiting_verification && data.verified === true) return { ...state, state: STATES.authenticated, authenticated: true, accountDisclosureAllowed: true, attempts: 0 };
  if (event === EVENTS.verification_failed && state.state === STATES.awaiting_verification) {
    const attempts = Number(state.attempts || 0) + 1;
    return { ...state, attempts, state: attempts >= MAX_ATTEMPTS ? STATES.locked : STATES.failed, authenticated: false, accountDisclosureAllowed: false };
  }
  return { ...state, authenticated: state.state === STATES.authenticated, accountDisclosureAllowed: state.state === STATES.authenticated };
}

function existingClientCustomerMessage(state) {
  if (state.state === STATES.authenticated) return "Your identity has been verified. I can now help with account-specific information.";
  if (state.state === STATES.locked) return "I couldn’t verify the details after several attempts. For your security, please contact Refalco Group team through an approved channel.";
  return "To protect your privacy, please provide the approved identifier or verification detail for your existing client account. I can’t disclose account-specific information before verification.";
}

function canDiscloseAccountInformation(state) { return Boolean(state && state.state === STATES.authenticated && state.authenticated === true && state.accountDisclosureAllowed === true); }

function canDiscloseExistingClientDetails(state) { return canDiscloseAccountInformation(state); }

// ===========================================================================
// P2.5 / W2.5.5 — existing client verification, BUILT not parked.
// ===========================================================================
//
// Everything above this line is the pre-P2.5 state machine and is unchanged.
// Every existing export keeps its signature and behaviour; the new capability
// branches alongside it rather than replacing it.
//
// What the plan requires (plan W2.5.5 + Anti Regression Checklist):
//   REFAL sends a one time code to the contact ALREADY ON FILE, the customer
//   reads it back, and only then is account data unlocked, for that
//   conversation only. A self asserted detail, or a caller number that happens
//   to match, is NEVER authentication.
//
// Security properties, each one testable:
//   - The code is generated with node:crypto randomInt. Math.random is a
//     predictable PRNG and must never generate an authentication secret.
//   - The code NEVER appears in the returned state, in the customer message,
//     in a log, or in any value this module returns. The state keeps a salted
//     SHA-256 hash only. The plaintext exists for the lifetime of one function
//     call and reaches nothing except the injected delivery function.
//   - Comparison is crypto.timingSafeEqual over the two digests, so a wrong
//     answer costs the same time as a right one.
//   - Single use, expiring (10 minutes by default), max MAX_ATTEMPTS attempts,
//     reusing the existing constant rather than introducing a second one.
//   - The destination is resolved ONLY from the account record. A contact the
//     customer supplies in the conversation is ignored by construction: there
//     is no parameter that can carry one into the delivery call.
//
// ---------------------------------------------------------------------------
// THE ONE FIELD FOR BOSS TO FILL (plan gate G6)
//
//   VERIFICATION_DELIVERY.sendVerificationCode
//
// set once at startup with setVerificationCodeSender(fn). It is the only thing
// this phase leaves open, and it is a FUNCTION, not a credential, so no secret
// ever enters this repository. Until BOSS registers it, the mechanism still
// runs end to end and the customer is routed to an approved channel instead of
// hitting a dead end.
// ---------------------------------------------------------------------------

const VERIFICATION_CODE_LENGTH = 6;
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_CONTACT_CHANNELS = Object.freeze(["whatsapp", "sms", "email"]);

const VERIFICATION_DELIVERY = { sendVerificationCode: null };

function setVerificationCodeSender(sender) {
  VERIFICATION_DELIVERY.sendVerificationCode = typeof sender === "function" ? sender : null;
  return VERIFICATION_DELIVERY.sendVerificationCode;
}

// The working default. It performs no live send from this repo and reports
// honestly that it did not deliver, which routes the customer to the approved
// channel message rather than silently claiming a code was sent.
function defaultVerificationCodeSender() {
  return { delivered: false, reason: "verification_sender_not_configured" };
}

function resolveSender(explicit) {
  if (typeof explicit === "function") return explicit;
  if (typeof VERIFICATION_DELIVERY.sendVerificationCode === "function") return VERIFICATION_DELIVERY.sendVerificationCode;
  return defaultVerificationCodeSender;
}

/**
 * Resolves the destination from the ACCOUNT RECORD only.
 *
 * `contactsOnFile` entries are the contacts Refalco Group already holds. An
 * entry explicitly marked `onFile: false` is skipped, which is how a contact
 * captured during the conversation is represented if a caller ever stores one
 * on the record. There is no code path from a conversation message to here.
 */
function resolveOnFileContact(accountRecord) {
  const record = accountRecord && typeof accountRecord === "object" ? accountRecord : {};
  const candidates = Array.isArray(record.contactsOnFile)
    ? record.contactsOnFile
    : (record.contactOnFile ? [record.contactOnFile] : []);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.onFile === false) continue;
    const channel = String(candidate.channel || "").trim().toLowerCase();
    const value = String(candidate.value || "").trim();
    if (!SUPPORTED_CONTACT_CHANNELS.includes(channel) || !value) continue;
    return { channel, value };
  }
  return null;
}

// A hint, never the contact. Enough for the customer to recognise which of
// their own details we used, not enough to be useful to anyone else.
function maskContact(contact) {
  if (!contact) return "";
  const value = String(contact.value || "");
  if (contact.channel === "email") {
    const [local, domain] = value.split("@");
    return `${String(local || "").slice(0, 1)}•••@${domain || ""}`;
  }
  const digits = value.replace(/\D/gu, "");
  return digits.length >= 4 ? `•••${digits.slice(-4)}` : "•••";
}

function hashVerificationCode(salt, code) {
  return crypto.createHash("sha256").update(`${salt}:${String(code)}`).digest();
}

const VERIFICATION_PROMPTS = Object.freeze({
  english: "For your security, I sent a 6 digit code to the contact we already have on file ({hint}). Please type that code here. It stays valid for 10 minutes.",
  arabic: "لأمانك، بعتت رمز من 6 أرقام على وسيلة التواصل الموجودة عنا بالملف ({hint}). اكتب الرمز هون من فضلك. بيضل صالح 10 دقائق.",
  greek: "Για την ασφάλειά σας, έστειλα έναν κωδικό 6 ψηφίων στο στοιχείο επικοινωνίας που έχουμε ήδη στον φάκελό σας ({hint}). Γράψτε τον εδώ. Ισχύει για 10 λεπτά."
});

const NO_CONTACT_ON_FILE = Object.freeze({
  english: "I cannot verify your identity here, because we do not have an approved contact detail on file for this account. Please reach the Refalco Group team through an approved channel and they will complete the verification with you.",
  arabic: "ما فيني أتحقق من هويتك هون، لأنه ما عنا وسيلة تواصل معتمدة بالملف لهالحساب. تواصل مع فريق Refalco Group عبر قناة معتمدة وهنّي بيكملوا التحقق معك.",
  greek: "Δεν μπορώ να επαληθεύσω την ταυτότητά σας εδώ, επειδή δεν έχουμε εγκεκριμένο στοιχείο επικοινωνίας στον φάκελο αυτού του λογαριασμού. Επικοινωνήστε με την ομάδα της Refalco Group μέσω εγκεκριμένου καναλιού και θα ολοκληρώσουν την επαλήθευση μαζί σας."
});

const DELIVERY_UNAVAILABLE = Object.freeze({
  english: "I am not able to send the verification code right now. Please reach the Refalco Group team through an approved channel and they will verify your identity with you.",
  arabic: "ما فيني أبعت رمز التحقق هلق. تواصل مع فريق Refalco Group عبر قناة معتمدة وهنّي بيتحققوا من هويتك معك.",
  greek: "Δεν μπορώ να στείλω τον κωδικό επαλήθευσης αυτή τη στιγμή. Επικοινωνήστε με την ομάδα της Refalco Group μέσω εγκεκριμένου καναλιού και θα επαληθεύσουν την ταυτότητά σας."
});

const CODE_EXPIRED = Object.freeze({
  english: "That code is no longer valid. I can send a new one to the contact we have on file whenever you are ready.",
  arabic: "هالرمز ما عاد صالح. فيني ابعت رمز جديد على وسيلة التواصل الموجودة بالملف وقت ما تجهز.",
  greek: "Αυτός ο κωδικός δεν ισχύει πλέον. Μπορώ να στείλω νέο στο στοιχείο επικοινωνίας που έχουμε στον φάκελο όποτε είστε έτοιμοι."
});

const CODE_INCORRECT = Object.freeze({
  english: "That code does not match. Please check the message we sent to the contact on file and try again.",
  arabic: "هالرمز ما بيطابق. راجع الرسالة اللي بعتناها على وسيلة التواصل الموجودة بالملف وجرب مرة تانية.",
  greek: "Ο κωδικός δεν ταιριάζει. Ελέγξτε το μήνυμα που στείλαμε στο στοιχείο επικοινωνίας του φακέλου και δοκιμάστε ξανά."
});

function existingClientVerificationPrompt(language = "english", { contactHint = "" } = {}) {
  return localizedLanguage(language, VERIFICATION_PROMPTS).replace("{hint}", contactHint);
}

/**
 * W2.5.5 — issue a one time code to the contact already on file.
 *
 * Returns the next state and a customer message. It NEVER returns the code.
 */
function issueVerificationCode(current = initialExistingClientState(), {
  accountRecord = null,
  sendCode = null,
  now = Date.now(),
  conversationId = null,
  language = "english",
  ttlMs = VERIFICATION_CODE_TTL_MS
} = {}) {
  const base = { ...initialExistingClientState(), ...(current || {}) };

  if (base.state === STATES.locked) {
    return { ok: false, reason: "locked", state: base, customerMessage: existingClientCustomerMessage(base) };
  }

  const contact = resolveOnFileContact(accountRecord);
  if (!contact) {
    return { ok: false, reason: "no_contact_on_file", state: base, customerMessage: localizedLanguage(language, NO_CONTACT_ON_FILE) };
  }

  const code = String(crypto.randomInt(0, 10 ** VERIFICATION_CODE_LENGTH)).padStart(VERIFICATION_CODE_LENGTH, "0");
  const salt = crypto.randomBytes(16).toString("hex");
  const contactHint = maskContact(contact);

  let delivery;
  try {
    delivery = resolveSender(sendCode)({ channel: contact.channel, to: contact.value, code, language, conversationId }) || {};
  } catch {
    delivery = { delivered: false, reason: "delivery_failed" };
  }

  if (delivery.delivered === false) {
    return { ok: false, reason: delivery.reason || "delivery_unavailable", state: base, customerMessage: localizedLanguage(language, DELIVERY_UNAVAILABLE) };
  }

  const state = {
    ...base,
    state: STATES.awaiting_verification,
    verification: {
      codeHash: hashVerificationCode(salt, code).toString("hex"),
      salt,
      issuedAt: Number(now),
      expiresAt: Number(now) + Number(ttlMs),
      consumed: false,
      channel: contact.channel,
      contactHint,
      conversationId: conversationId === undefined ? null : conversationId
    }
  };

  return {
    ok: true,
    reason: null,
    state,
    channel: contact.channel,
    contactHint,
    // Built here rather than passed through from the sender, so a sender that
    // echoed the code back could not leak it into a caller's logs.
    delivery: { delivered: true, channel: contact.channel, contactHint },
    customerMessage: existingClientVerificationPrompt(language, { contactHint })
  };
}

function closedVerification(record, reason, now) {
  return {
    consumed: true,
    closedReason: reason,
    closedAt: Number(now),
    channel: record.channel || null,
    contactHint: record.contactHint || null,
    conversationId: record.conversationId === undefined ? null : record.conversationId
  };
}

/**
 * W2.5.5 — the customer reads the code back.
 *
 * Accepts the state in `awaiting_verification` or in `failed`, because a wrong
 * attempt leaves the pre-existing machine in `failed` and the customer is
 * entitled to the remaining attempts on the same code.
 */
function submitVerificationCode(current = initialExistingClientState(), answer, { now = Date.now(), language = "english" } = {}) {
  const base = { ...initialExistingClientState(), ...(current || {}) };
  const record = base.verification;

  if (![STATES.awaiting_verification, STATES.failed].includes(base.state) || !record || typeof record !== "object") {
    return { ok: false, reason: "not_awaiting_verification", state: base, customerMessage: existingClientCustomerMessage(base) };
  }

  // Checked before the hash is read, because a consumed record has no hash left.
  if (record.consumed === true) {
    const next = failVerification(base, record, "code_already_used", now);
    return { ok: false, reason: "code_already_used", state: next, customerMessage: localizedLanguage(language, CODE_EXPIRED) };
  }

  if (!record.codeHash || !record.salt) {
    return { ok: false, reason: "not_awaiting_verification", state: base, customerMessage: existingClientCustomerMessage(base) };
  }

  if (Number(now) > Number(record.expiresAt)) {
    const next = failVerification(base, record, "expired", now);
    return { ok: false, reason: "expired", state: next, customerMessage: localizedLanguage(language, CODE_EXPIRED) };
  }

  const expected = Buffer.from(record.codeHash, "hex");
  const actual = hashVerificationCode(record.salt, String(answer ?? "").trim());
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    const next = failVerification(base, record, "incorrect_code", now);
    const locked = next.state === STATES.locked;
    return { ok: false, reason: locked ? "locked" : "incorrect_code", state: next, customerMessage: locked ? existingClientCustomerMessage(next) : localizedLanguage(language, CODE_INCORRECT) };
  }

  // Success. The hash and salt are dropped here, which is what makes the code
  // single use: a second presentation of the same digits finds a consumed
  // record and is rejected before any comparison happens.
  const scrubbed = { ...base, state: STATES.awaiting_verification, verification: closedVerification(record, "verified", now) };
  const next = transitionExistingClientState(scrubbed, EVENTS.verification_passed, { verified: true });
  next.verifiedConversationId = record.conversationId === undefined ? null : record.conversationId;

  return { ok: true, reason: null, state: next, customerMessage: existingClientCustomerMessage(next) };
}

function failVerification(base, record, reason, now) {
  const awaiting = { ...base, state: STATES.awaiting_verification };
  const next = transitionExistingClientState(awaiting, EVENTS.verification_failed);
  const keepCode = reason === "incorrect_code" && next.state !== STATES.locked;
  next.verification = keepCode ? { ...record } : closedVerification(record, reason, now);
  return next;
}

/**
 * W2.5.5 — a self asserted detail is NEVER authentication.
 *
 * A name, an account number read out loud, or a caller number that matches the
 * one on file are all things an impersonator can obtain. This records that a
 * claim was made, and nothing else: no claimed value is stored, because the
 * values are personal data with no authentication worth.
 */
function applySelfAssertedIdentity(current = initialExistingClientState(), claim = {}) {
  const base = { ...initialExistingClientState(), ...(current || {}) };
  if (base.state === STATES.authenticated) return base;
  return {
    ...base,
    state: base.state === STATES.unauthenticated ? STATES.awaiting_identifier : base.state,
    selfAsserted: true,
    callerNumberMatchesFile: Boolean(claim && claim.callerNumberMatchesFile),
    authenticated: false,
    accountDisclosureAllowed: false
  };
}

/**
 * W2.5.5 — unlocked for THAT CONVERSATION only.
 *
 * A state verified in one conversation does not unlock another. States created
 * before this phase carry no binding; those keep the previous behaviour rather
 * than being locked out retroactively.
 */
function canDiscloseAccountInformationInConversation(state, conversationId) {
  if (!canDiscloseAccountInformation(state)) return false;
  const bound = state.verifiedConversationId ?? (state.verification && state.verification.conversationId);
  if (bound === null || bound === undefined) return true;
  return String(bound) === String(conversationId ?? "");
}

module.exports = {
  STATES,
  EVENTS,
  MAX_ATTEMPTS,
  initialExistingClientState,
  beginExistingClientFlow,
  transitionExistingClientState,
  existingClientCustomerMessage,
  canDiscloseAccountInformation,
  canDiscloseExistingClientDetails,
  // P2.5 / W2.5.5 additions
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_TTL_MS,
  SUPPORTED_CONTACT_CHANNELS,
  VERIFICATION_DELIVERY,
  setVerificationCodeSender,
  resolveOnFileContact,
  maskContact,
  existingClientVerificationPrompt,
  issueVerificationCode,
  submitVerificationCode,
  applySelfAssertedIdentity,
  canDiscloseAccountInformationInConversation
};
