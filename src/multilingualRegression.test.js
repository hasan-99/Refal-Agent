// REFAL-AGENT-014: EN/AR/EL behavior-equivalence regression suite.
//
// Principle: equivalent customer intent should produce equivalent system
// behavior across English/Arabic/Greek. Each test runs the SAME scenario in
// all three languages (where the underlying mechanism supports all three)
// and asserts on outcome/selected tool/policy verdict/workflow state, not on
// "the text contains language X" alone. Scenario numbers below refer to the
// REFAL-AGENT-014 ticket's required scenario list.
//
// Known, deliberately-NOT-fixed gaps (see docs/refal-agent-refactor-progress.md
// for the full writeup and deferred-ticket proposals) are characterized here
// as tests that document CURRENT behavior, not silently patched:
//   - followUp.js's cron-level goodbye detection has no Greek (scenario 21-23)
//   - conversationRecap.js's complaint recap always reuses the same invented
//     backstory regardless of the real complaint (scenario 26)

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { google } = require("googleapis");

const { runAgentTurn } = require("./agentLoop");
const { buildAgentContext } = require("./agentContext");
const {
  validateResponse,
  questionCount,
  MODEL_DRAFT_THRESHOLDS,
  AGENT_CLARIFY_THRESHOLDS,
  LEGACY_RESPONSE_THRESHOLDS
} = require("./responsePolicy");
const { consentFromText, getConsentState, CONSENT_STATES } = require("./leadQualification");
const { detectMessageLanguage, detectExplicitLanguageRequest } = require("./language");
const { assessPriority } = require("./priorityRules");
const { detectIntent } = require("./intent");
const { classifySafety, SAFETY_CATEGORIES } = require("./safetyPolicy");
const { extractSafeRequestFromPrivacyMessage } = require("./privacyIntent");
const { containsRawSecretValue } = require("./sensitiveData");
const { createHandover } = require("./handover");
const { isNaturalConversationEnd } = require("./followUp");
const { buildLocalConversationRecap } = require("./conversationRecap");
const { handleBookingMessage, isBookingRequest } = require("./booking");
const { languageSignalsFrom, questionSignalsFrom } = require("./agentObservability");
const { routeMessageResult } = require("./messageRouter");

// --- shared helpers --------------------------------------------------------

function scriptedDecider(decisions) {
  let index = 0;
  return async () => decisions[Math.min(index++, decisions.length - 1)];
}

function agentContextFor(locale, message, overrides = {}) {
  return buildAgentContext({ currentMessage: message, locale, ...overrides });
}

function integrationStore(user) {
  const calls = user.workflowCalls || (user.workflowCalls = []);
  return {
    ensureUser: async () => user,
    getUser: async () => user,
    updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response, extra) => {
      const turn = { message, response, metadata: extra?.metadata || {} };
      user.history.push(turn);
      return turn;
    },
    saveQualification: async (...args) => calls.push(["qualification", ...args]),
    saveIntents: async (...args) => calls.push(["intents", ...args]),
    saveConsent: async (...args) => calls.push(["consent", ...args]),
    createHandover: async (...args) => { calls.push(["handover", ...args]); return { id: "handover-test-id" }; },
    createNotification: async (...args) => { calls.push(["notification", ...args]); return { id: "notification-test-id" }; },
    createPriorityAlert: async (...args) => calls.push(["priority", ...args]),
    createComplaint: async (...args) => calls.push(["complaint", ...args]),
    saveExistingClientVerification: async (...args) => calls.push(["existing_client", ...args])
  };
}

const BOOKING_POLICY = {
  timezone: "Europe/Nicosia", calendarId: "primary", weekdays: [1, 2, 3, 4, 5],
  startTime: "08:30", endTime: "11:00", durationMinutes: 30, durationOwnerConfirmed: true,
  minimumNoticeHours: 24, reminderHours: [12], createMeetLink: true
};

function resetCalendarEnv(t, configured) {
  const keys = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN", "GOOGLE_CALENDAR_CLIENT_EMAIL", "GOOGLE_CALENDAR_PRIVATE_KEY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = configured ? `test-${key.toLowerCase()}` : "";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// --- 1. Simple information request -----------------------------------------

test("[014-1] simple information request: RAG used, no booking/handover, <=1 question, EN/AR/EL", async () => {
  const CASES = {
    english: { msg: "What services does the business provide?", answer: "the business provides company formation, accounting, and tax filing services in Cyprus." },
    arabic: { msg: "شو الخدمات يلي بتقدمها الشركة؟", answer: "الشركة بتقدم خدمات تأسيس الشركات والمحاسبة وتقديم الإقرارات الضريبية في قبرص." },
    greek: { msg: "Ποιες υπηρεσίες προσφέρει η the business;", answer: "Η the business προσφέρει υπηρεσίες σύστασης εταιρειών, λογιστικής και φορολογικών δηλώσεων στην Κύπρο." }
  };
  for (const [locale, { msg, answer }] of Object.entries(CASES)) {
    // REFAL-AGENT-028: the new factual-grounding gate reads ONLY
    // `modelObservation` (never raw `data`) — the stub's evidence content is
    // the same text as `answer` so the claimed services are grounded.
    const tools = {
      searchApprovedKnowledge: {
        run: async () => ({
          ok: true,
          status: "found",
          data: [{ heading: "Services", content: answer }],
          modelObservation: { type: "approved_knowledge", status: "found", evidence: [{ title: "Services", section: null, content: answer, contentTruncated: false, sourceRef: null }], truncated: false }
        })
      }
    };
    const decide = scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: msg } },
      { type: "respond", text: answer }
    ]);
    const result = await runAgentTurn(agentContextFor(locale, msg), { decideNextStep: decide, tools });
    assert.equal(result.outcome, "responded", locale);
    assert.equal(result.toolsUsed.includes("searchApprovedKnowledge"), true, locale);
    assert.equal(result.toolsUsed.includes("proposeHandover"), false, locale);
    assert.equal(result.toolsUsed.includes("requestBookingAction"), false, locale);
    assert.ok(questionCount(result.response) <= 1, locale);
    assert.equal(result.response, answer, locale);
  }
});

// --- 2. Price-only question --------------------------------------------------

test("[014-2] price-only question: RAG used, price-focused answer, no forced qualification question, EN/AR/EL", async () => {
  const CASES = {
    english: { msg: "How much does company formation cost?", answer: "Company formation in Cyprus is published at EUR 1500, including registration." },
    arabic: { msg: "قديش تكلفة تأسيس الشركة؟", answer: "تأسيس الشركة في قبرص بسعر معلن 1500 يورو، شامل التسجيل." },
    greek: { msg: "Πόσο κοστίζει η σύσταση εταιρείας;", answer: "Η σύσταση εταιρείας στην Κύπρο κοστίζει 1500 ευρώ, συμπεριλαμβανομένης της καταχώρισης." }
  };
  for (const [locale, { msg, answer }] of Object.entries(CASES)) {
    // REFAL-AGENT-028: modelObservation added (price "1500" must be
    // present on the evidence the grounding gate actually reads).
    const tools = {
      searchApprovedKnowledge: {
        run: async () => ({
          ok: true,
          status: "found",
          data: [{ heading: "Pricing", content: "EUR 1500" }],
          modelObservation: { type: "approved_knowledge", status: "found", evidence: [{ title: "Pricing", section: null, content: "EUR 1500", contentTruncated: false, sourceRef: null }], truncated: false }
        })
      }
    };
    const decide = scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: msg } },
      { type: "respond", text: answer }
    ]);
    const result = await runAgentTurn(agentContextFor(locale, msg), { decideNextStep: decide, tools });
    assert.equal(result.outcome, "responded", locale);
    assert.equal(result.toolsUsed.includes("proposeHandover"), false, locale);
    assert.equal(result.toolsUsed.includes("requestBookingAction"), false, locale);
    assert.ok(questionCount(result.response) === 0, locale);
    assert.equal(result.response, answer, locale);
  }
});

// --- 3. "I want information first" ------------------------------------------

test("[014-3] customer wants information before a person: no forced handover, no contact promise, EN/AR/EL", async () => {
  const CASES = {
    english: { msg: "I'd like information first before speaking to anyone.", answer: "Of course — here is the published information on company formation timelines and requirements." },
    arabic: { msg: "بدي معلومات الأول قبل ما احكي مع حدا.", answer: "أكيد، هاي المعلومات المعتمدة عن مدة وإجراءات تأسيس الشركة." },
    greek: { msg: "Θέλω πρώτα πληροφορίες πριν μιλήσω με κάποιον.", answer: "Φυσικά — αυτές είναι οι εγκεκριμένες πληροφορίες για τη διαδικασία και τον χρόνο σύστασης εταιρείας." }
  };
  for (const [locale, { msg, answer }] of Object.entries(CASES)) {
    const decide = scriptedDecider([{ type: "respond", text: answer }]);
    const result = await runAgentTurn(agentContextFor(locale, msg), { decideNextStep: decide, tools: {} });
    assert.equal(result.outcome, "responded", locale);
    assert.equal(result.toolsUsed.includes("proposeHandover"), false, locale);
    const policy = validateResponse(answer, MODEL_DRAFT_THRESHOLDS);
    assert.equal(policy.unconsentedContactCommitment, false, locale);
  }
});

// --- 4. Open-question indirect answer ---------------------------------------

test("[014-4] an indirect answer to a previously-asked business-activity question is not re-asked, EN/AR/EL", async () => {
  // Reuses messageRouter.js's real COMPANY_ACTIVITY_QUESTION trigger text
  // (opportunityIntake.js) so pendingIntakeAnswer's real regex recognizes the
  // prior turn as the open question, then checks the natural indirect reply
  // does not trigger the same question again (no literal re-ask).
  const CASES = {
    english: { lastQuestion: "What will the company do?", reply: "We sell handmade furniture online." },
    arabic: { lastQuestion: "شو رح تعمل الشركة؟", reply: "منبيع أثاث يدوي عالإنترنت." },
    greek: { lastQuestion: "Τι δραστηριότητα θα έχει η εταιρεία;", reply: "Πουλάμε χειροποίητα έπιπλα online." }
  };
  for (const [locale, { lastQuestion, reply }] of Object.entries(CASES)) {
    const user = {
      id: `intake-${locale}`,
      profile: { opportunityIntake: { type: "company_formation", status: "in_progress", updatedAt: new Date().toISOString() } },
      history: [{ message: "I want to set up a company", response: lastQuestion }]
    };
    const result = await routeMessageResult({ userId: user.id, text: reply, store: integrationStore(user), existingUser: user });
    assert.doesNotMatch(result.response, /what will the company do|شو رح تعمل الشركة|τι δραστηριότητα θα έχει/iu, locale);
  }
});

// --- 5. Topic change ----------------------------------------------------------

test("[014-5] a topic change becomes the primary request instead of re-prompting a stale open question, EN/AR/EL", async () => {
  const CASES = {
    english: { lastQuestion: "What will the company do?", newTopic: "Actually, I have a complaint about the service I already received." },
    arabic: { lastQuestion: "شو رح تعمل الشركة؟", newTopic: "في الحقيقة عندي شكوى عن الخدمة يلي استلمتها." },
    greek: { lastQuestion: "Τι δραστηριότητα θα έχει η εταιρεία;", newTopic: "Βασικά, έχω ένα παράπονο για την υπηρεσία που ήδη έλαβα." }
  };
  for (const [locale, { lastQuestion, newTopic }] of Object.entries(CASES)) {
    const user = {
      id: `topic-change-${locale}`,
      profile: { opportunityIntake: { type: "company_formation", status: "in_progress", updatedAt: new Date().toISOString() } },
      history: [{ message: "I want to set up a company", response: lastQuestion }]
    };
    const result = await routeMessageResult({ userId: user.id, text: newTopic, store: integrationStore(user), existingUser: user });
    assert.doesNotMatch(result.response, /what will the company do|شو رح تعمل الشركة|τι δραστηριότητα θα έχει/iu, locale);
    assert.equal(result.metadata.intent.intents.includes("complaint"), true, locale);
  }
});

// --- 6. Generic acknowledgement ----------------------------------------------

test("[014-6] a bare acknowledgement is not read as consent or a booking confirmation, EN/AR/EL", () => {
  for (const text of ["okay", "understood", "thanks", "تمام", "شكرا", "ευχαριστώ", "εντάξει"]) {
    assert.equal(consentFromText(text), CONSENT_STATES.UNKNOWN, text);
  }
});

// --- 7. Explicit contact consent ---------------------------------------------

test("[014-7] explicit specialist-contact consent is recognized, EN/AR/EL", () => {
  for (const text of [
    "Yes, I want a specialist to contact me.",
    "نعم، حابب حدا من المختصين يتواصل معي.",
    "Ναι, παρακαλώ επικοινωνήστε μαζί μου."
  ]) assert.equal(consentFromText(text), CONSENT_STATES.GRANTED, text);
});

// --- 8. Contact decline -------------------------------------------------------

test("[014-8] a clear decline of human follow-up does not authorize a handover, EN/AR/EL", () => {
  for (const text of [
    "No thanks, not now.",
    "لا شكرًا، مو هلأ.",
    "Όχι ευχαριστώ, όχι τώρα."
  ]) {
    const state = consentFromText(text);
    assert.notEqual(state, CONSENT_STATES.GRANTED, text);
  }
});

// --- 9. Consent revocation -----------------------------------------------------

test("[014-9] a later revocation overrides an earlier grant, independent of which language each turn used", () => {
  const sequences = [
    ["Yes, I want a specialist to contact me.", "Actually, don't contact me anymore."],
    ["نعم تواصل معي", "لا تتواصل معي بعد اليوم"],
    ["Ναι, επικοινωνήστε μαζί μου", "Σταματήστε, μη μου στέλνετε"],
    // a grant in one language revoked in another — the mechanism is a single
    // last-write-wins loop over consentFromText, not a per-language state.
    ["Yes, I want a specialist to contact me.", "لا تتواصل معي"]
  ];
  for (const [grant, revoke] of sequences) {
    const user = { history: [{ message: grant }, { message: revoke }] };
    assert.equal(getConsentState({ user }), CONSENT_STATES.REVOKED, JSON.stringify([grant, revoke]));
  }
});

// --- 10. Booking request -------------------------------------------------------

test("[014-10] a booking request flows to pending-review in the customer's own language, never a self-confirmed claim, EN/AR/EL", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) } });
  t.after(() => { google.calendar = originalCalendar; });

  const CASES = {
    english: { start: "I'd like to book a meeting", details: "Monday 10:00 to discuss the business services", confirm: "yes", expect: /appointment request has been sent for review/i },
    arabic: { start: "أريد حجز اجتماع", details: "الاثنين الساعة 10:00 لمناقشة خدمات الشركة", confirm: "نعم", expect: /طلب الموعد للمراجعة/ },
    // normalizeArabicBookingText translates Arabic weekday words before
    // chrono parsing; no equivalent Greek word-normalizer exists yet (a
    // real, separate gap documented in the progress doc, not fixed here),
    // so the Greek fixture uses an explicit date chrono can parse directly.
    greek: { start: "Θέλω να κλείσω ένα ραντεβού", details: "2026-01-05 10:00 για τις υπηρεσίες της the business", confirm: "ναι", expect: /αίτημα ραντεβού σας στάλθηκε για έλεγχο/ }
  };
  for (const [locale, { start, details, confirm, expect }] of Object.entries(CASES)) {
    const user = { id: `booking-${locale}`, phone: "35799000000", profile: { name: "Test" }, booking: null };
    const appointmentId = `${locale}-appt-id`;
    const persisted = { id: appointmentId, status: "pending_review", created_at: "2026-01-02T08:00:00.000Z" };
    const store = {
      ensureUser: async () => user,
      getBookingPolicy: async () => BOOKING_POLICY,
      updateUser: async (_id, update) => { update(user); return user; },
      createAppointment: async (value) => { Object.assign(persisted, { starts_at: value.startsAt, ends_at: value.endsAt }); return { appointment: persisted, created: true }; },
      updateAppointment: async (_id, value) => { Object.assign(persisted, value); return persisted; },
      createReminder: async () => {}
    };
    const now = new Date("2026-01-02T08:00:00.000Z");
    await handleBookingMessage({ userId: user.id, text: start, store, now });
    const proposed = await handleBookingMessage({ userId: user.id, text: details, store, now });
    assert.doesNotMatch(proposed.response, /confirmed|تم تأكيد|επιβεβαιώθηκε/i, locale);
    const confirmed = await handleBookingMessage({ userId: user.id, text: confirm, store, now });
    assert.match(confirmed.response, expect, locale);
    assert.doesNotMatch(confirmed.response, /confirmed\.|تم تأكيد الموعد|Επιβεβαιώθηκε\./, locale);
    assert.equal(persisted.status, "pending_review", locale);
  }
});

// --- 11. Booking failure --------------------------------------------------------

test("[014-11] a calendar access failure never claims success, in the customer's language, EN/AR/EL", async (t) => {
  resetCalendarEnv(t, true);
  const originalCalendar = google.calendar;
  google.calendar = () => ({ freebusy: { query: async () => { throw new Error("invalid_grant"); } } });
  t.after(() => { google.calendar = originalCalendar; });

  const CASES = {
    english: { text: "I'd like to book a meeting", expect: /cannot currently access the business's calendar/i },
    arabic: { text: "أريد حجز اجتماع", expect: /تعذر الوصول إلى تقويم الشركة/ },
    greek: { text: "Θέλω να κλείσω ραντεβού", expect: /Δεν είναι δυνατή αυτή τη στιγμή η πρόσβαση στο ημερολόγιο/ }
  };
  for (const [locale, { text, expect }] of Object.entries(CASES)) {
    const user = { id: `bookfail-${locale}`, profile: {}, booking: null };
    const store = { ensureUser: async () => user, getBookingPolicy: async () => BOOKING_POLICY, updateUser: async (_id, update) => update(user) };
    const result = await handleBookingMessage({ userId: user.id, text, store });
    assert.match(result.response, expect, locale);
    assert.doesNotMatch(result.response, /confirmed|تم تأكيد|επιβεβαιώθηκε/i, locale);
  }
});

// --- 12. Two-question draft ------------------------------------------------------

test("[014-12] a two-question draft is rejected identically for Latin '?', Arabic '؟', and Greek ';' punctuation", () => {
  const drafts = {
    english: "What is your budget? When would you like to start?",
    arabic: "شو ميزانيتك؟ وامتى بدك تبدأ؟",
    greek: "Ποιος είναι ο προϋπολογισμός σας; Πότε θέλετε να ξεκινήσετε;"
  };
  for (const [locale, text] of Object.entries(drafts)) {
    assert.equal(questionCount(text), 2, locale);
    const policy = validateResponse(text, LEGACY_RESPONSE_THRESHOLDS);
    assert.ok(policy.reasons.includes("too_many_questions"), locale);
  }
});

// --- 13. Zero-question answer -----------------------------------------------------

test("[014-13] a complete answer with no follow-up question is valid, EN/AR/EL", () => {
  for (const text of [
    "Company formation in Cyprus takes approximately five business days.",
    "تأسيس الشركة في قبرص بياخد حوالي خمس أيام عمل.",
    "Η σύσταση εταιρείας στην Κύπρο διαρκεί περίπου πέντε εργάσιμες ημέρες."
  ]) {
    assert.equal(questionCount(text), 0, text);
    assert.equal(validateResponse(text, MODEL_DRAFT_THRESHOLDS).valid, true, text);
  }
});

// --- 14. Concise one-sentence answer ------------------------------------------------

test("[014-14] a correct one-sentence answer is not rejected for being short, EN/AR/EL", () => {
  for (const text of [
    "No, we don't currently offer that service.",
    "لا، ما بنقدم هالخدمة حاليًا.",
    "Όχι, δεν προσφέρουμε αυτή την υπηρεσία αυτή τη στιγμή."
  ]) {
    for (const thresholds of [MODEL_DRAFT_THRESHOLDS, AGENT_CLARIFY_THRESHOLDS, LEGACY_RESPONSE_THRESHOLDS]) {
      assert.equal(validateResponse(text, thresholds).valid, true, `${text} / ${JSON.stringify(thresholds)}`);
    }
  }
});

// --- 15. Credential type mentioned safely ---------------------------------------------

test("[014-15] KNOWN BUG (deferred, not fixed in this ticket): a bare mention of a credential TYPE is STILL misclassified as a privacy risk, symmetrically in EN/AR/EL", () => {
  // safetyPolicy.js's PRIVACY rule (src/safetyPolicy.js:17) was assumed by
  // ticket 011's trace to require a value-looking token after the keyword
  // (e.g. "password: xyz123"), but that value requirement only applies to
  // the OTP/one-time-code sub-pattern. "password"/"secret"/"access token"/
  // "api key" etc. are separate, UNCONDITIONAL bare-word alternatives in the
  // same regex, so an ordinary support question is still misclassified —
  // equally in all three languages, confirmed here, not just in English.
  // This directly reproduces the original pre-ticket-011 audit finding; see
  // the progress doc's new ticket proposal for safetyPolicy.js.
  for (const text of [
    "How do I reset my password?",
    "كيف بقدر أغيّر كلمة المرور تبعي؟",
    "Πώς μπορώ να επαναφέρω τον κωδικό μου;"
  ]) {
    assert.equal(classifySafety(text).risks.includes(SAFETY_CATEGORIES.PRIVACY), true, text);
  }
});

// --- 16. Actual credential value present -------------------------------------------------

test("[014-16] an actual secret-like value is detected and never echoed back, EN/AR", () => {
  const CARD = "4111111111111111"; // passes Luhn
  for (const text of [
    `My card number is ${CARD}`,
    `رقم بطاقتي هو ${CARD}`
  ]) {
    assert.equal(containsRawSecretValue(text), true, text);
  }
  // A response that echoes the raw value back must fail validateResponse.
  assert.equal(validateResponse(`Your card ${CARD} is on file.`, MODEL_DRAFT_THRESHOLDS).reasons.includes("sensitive_value_echo"), true);
});

// --- 17. Refusal to share credentials ------------------------------------------------------

test("[014-17] KNOWN BUG (deferred, not fixed in this ticket): a refusal to share a credential is STILL sometimes misread as disclosure, symmetrically in EN/AR/EL", () => {
  // NON_DISCLOSURE_CLAUSE's noun list only has bare "tokens?", not the
  // compound phrase "access token(s)" that the main PRIVACY rule matches as
  // a unit — so "I will not share my access token" is not fully stripped
  // before rule-matching and the bare "access token" phrase still trips the
  // PRIVACY rule. Same root cause/scope as [014-15]; see the progress doc.
  assert.equal(classifySafety("I will not share my access token.").risks.includes(SAFETY_CATEGORIES.PRIVACY), true);
  assert.equal(classifySafety("ما رح أرسل رمز الدخول تبعي.").risks.includes(SAFETY_CATEGORIES.PRIVACY), true);
  assert.equal(classifySafety("Δεν θα στείλω τον κωδικό πρόσβασής μου.").risks.includes(SAFETY_CATEGORIES.PRIVACY), true);
  // A refusal phrased around the exact noun NON_DISCLOSURE_CLAUSE DOES list
  // (bare "password", not "access token") is correctly recognized as safe —
  // confirming the carve-out mechanism itself works, the gap is coverage.
  assert.equal(classifySafety("I will not share my password.").risks.includes(SAFETY_CATEGORIES.PRIVACY), false);
});

// --- 18. Internal reasoning leakage -------------------------------------------------------

test("[014-18] internal-reasoning leakage (score/routing label/tool name) is rejected, EN/AR/EL", () => {
  for (const text of [
    "Lead score: 92. Routing decision: urgent.",
    "درجة التأهيل: ٩٢. تصنيف الأولوية: عاجل.",
    "Βαθμολογία προτεραιότητας: 92. Ταξινόμηση πελάτη: επείγον.",
    "Let me call searchApprovedKnowledge to check that."
  ]) {
    const policy = validateResponse(text, MODEL_DRAFT_THRESHOLDS);
    assert.equal(policy.reasons.includes("internal_reasoning"), true, text);
  }
});

// --- 19. Unverified handover claim ----------------------------------------------------------

test("[014-19] an unverified handover-completion claim is rejected regardless of language, and the Agent path can never mark one verified today", () => {
  // Two overlapping guards cover "a specialist/team will follow up" style
  // claims: UNCONSENTED_CONTACT_COMMITMENT (a future promise) and
  // HANDOVER_ACTION_CLAIM (a completed-logging claim) — which one fires
  // depends on exact phrasing, but either reason means the claim is blocked.
  for (const text of [
    "I've asked a specialist to contact you.",
    "رح يتواصل معك المختص قريباً.",
    "Η ομάδα θα επικοινωνήσει μαζί σας σύντομα."
  ]) {
    const policy = validateResponse(text, MODEL_DRAFT_THRESHOLDS);
    assert.equal(policy.valid, false, text);
    assert.ok(
      policy.reasons.includes("unverified_handover_action") || policy.reasons.includes("unconsented_contact_commitment"),
      `${text}: ${policy.reasons.join(",")}`
    );
  }
  // agentLoop.js never passes allowVerifiedHandoverClaim to validateResponse,
  // so today the Agent respond/clarify path rejects this claim unconditionally
  // — fail-closed by construction, not just by the right test data.
  const decide = scriptedDecider([{ type: "respond", text: "I've asked a specialist to contact you." }]);
  return runAgentTurn(agentContextFor("english", "please get a specialist to call me"), { decideNextStep: decide, tools: {} })
    .then((result) => assert.equal(result.outcome, "response_rejected"));
});

// --- 20. Unverified booking claim -------------------------------------------------------------

test("[014-20] an unverified booking-completion claim is rejected regardless of language", () => {
  for (const text of [
    "Your appointment is confirmed.",
    "تم تأكيد موعدك.",
    "Το ραντεβού σας επιβεβαιώθηκε."
  ]) {
    assert.equal(validateResponse(text, MODEL_DRAFT_THRESHOLDS).reasons.includes("unverified_booking_action"), true, text);
  }
});

// --- 21-23. Goodbye / conversation-end behavior -----------------------------------------------

test("[014-21/22/23] a short farewell reply needs no follow-up question and passes policy, EN/AR/EL", () => {
  for (const text of [
    "You're welcome — happy to help anytime.",
    "عفوًا، تحت أمرك بأي وقت.",
    "Παρακαλώ, είμαι στη διάθεσή σας όποτε χρειαστεί."
  ]) {
    assert.equal(questionCount(text), 0, text);
    assert.equal(validateResponse(text, AGENT_CLARIFY_THRESHOLDS).valid, true, text);
  }
});

test("[014-21/22/23] KNOWN BUG (deferred, not fixed in this ticket): the cron-level goodbye detector only reliably works for English — Arabic is also silently broken, Greek is entirely unsupported", () => {
  assert.equal(isNaturalConversationEnd("Thanks, bye!"), true);
  // isNaturalConversationEnd's regex wraps every alternative in \b without
  // the 'u' flag. In non-unicode mode \b only fires at a transition between
  // an ASCII \w character and a non-\w character; Arabic letters are never
  // \w in that mode, so \b can never match adjacent to Arabic script at all
  // — the Arabic terms in this regex are unreachable dead patterns, not a
  // working EN/AR detector. This is a deeper bug than "Greek is missing".
  assert.equal(isNaturalConversationEnd("شكراً، مع السلامة"), false);
  // Greek terms are not present in the pattern at all (a separate gap).
  assert.equal(isNaturalConversationEnd("Ευχαριστώ, αντίο"), false);
});

// --- 24. Language switch mid-conversation ---------------------------------------------------

test("[014-24] the current message's language is authoritative each turn: EN->AR, EN->EL, AR->EN", () => {
  const sequences = [
    ["I need help with my company", "english"],
    ["بدي مساعدة بموضوع شركتي", "arabic"],
    ["Χρειάζομαι βοήθεια με την εταιρεία μου", "greek"]
  ];
  for (const [text, expected] of sequences) assert.equal(detectMessageLanguage(text), expected, text);

  // detectIntent recomputes language fresh from the current message every
  // call — a prior turn's language does not stick.
  assert.equal(detectIntent("What is the price?").language, "english");
  assert.equal(detectIntent("شو السعر؟").language, "arabic");
  assert.equal(detectIntent("Ποια είναι η τιμή;").language, "greek");

  // An explicit switch request is also recognized in each direction.
  assert.equal(detectExplicitLanguageRequest("Can we continue in Arabic?"), "arabic");
  assert.equal(detectExplicitLanguageRequest("ممكن نكمل بالعربي"), "arabic");
  assert.equal(detectExplicitLanguageRequest("Μπορούμε να συνεχίσουμε στα ελληνικά;"), "greek");
});

// --- 25. Mixed-language names / brands / technical terms ---------------------------------------

test("[014-25] a brand/technical English term inside a normal Arabic/Greek sentence does not flip detected language", () => {
  assert.equal(detectMessageLanguage("الشركة بتقدم خدمات تأسيس الشركات في قبرص عبر OpenRouter."), "arabic");
  assert.equal(detectMessageLanguage("Η the business βρίσκεται στην Κύπρο και χρησιμοποιεί OpenRouter."), "greek");
  // Documented limitation (not fixed here): a short reply DOMINATED by an
  // English clause/URL (more Latin script than Arabic/Greek script) can
  // still flip the majority-script vote — this is a known edge case flagged
  // in the 014 trace, not a false claim that the detector is perfect.
});

// --- 26. Complaint handling --------------------------------------------------------------------

test("[014-26] KNOWN BUG (deferred, not fixed in this ticket): complaint recap reuses a fixed backstory regardless of the real complaint topic, EN/AR/EL", () => {
  const CASES = {
    english: ["This is a complaint: my refund was never processed and no one has explained why.", "Please summarize what I told you."],
    arabic: ["عندي شكوى: المبلغ المسترجع ما تحول أبداً وحدا ما فسرلي ليش.", "لخّص شو قلتلك."],
    greek: ["Έχω ένα παράπονο: η επιστροφή χρημάτων μου δεν έγινε ποτέ και κανείς δεν εξήγησε γιατί.", "Παρακαλώ συνοψίστε τι σας είπα."]
  };
  for (const [locale, [complaintMessage, recapRequest]] of Object.entries(CASES)) {
    const history = [{ message: complaintMessage }];
    const result = buildLocalConversationRecap({ history, currentMessage: recapRequest, language: locale });
    // The recap mentions a "company-setup case submitted last month" even
    // though this complaint was about a refund — the invented backstory does
    // not reflect the actual complaint content. This is REFAL-AGENT-014's
    // required characterization of a known, still-present bug (see the
    // "Complaint handling" ticket proposal in the progress doc), not a fix.
    assert.match(result.response, /company-setup case submitted last month|معاملة تأسيس شركة الشهر الماضي|υπόθεση σύστασης εταιρείας τον περασμένο μήνα/, locale);
    assert.doesNotMatch(result.response, /refund|استرجاع|επιστροφή/iu, locale);
  }
});

// --- 27. False priority words ----------------------------------------------------------------

test("[014-27] bare 'media'/'press'/'land'/'account' words do not force urgent/high priority, EN/AR/EL", () => {
  for (const text of [
    "What social media accounts does the business have?",
    "Is land available near Limassol?",
    "شو حسابات السوشال ميديا تبع الشركة؟",
    "Ποιοι λογαριασμοί μέσων κοινωνικής δικτύωσης έχει η the business;"
  ]) {
    const result = assessPriority({ text });
    assert.equal(result.level, "normal", text);
  }
  // True positives still escalate — including the Greek media/press term
  // added in this ticket (previously Greek was entirely missing here).
  for (const text of [
    "I've spoken to a lawyer about a formal complaint.",
    "محامي قدملي شكوى رسمية بهالموضوع.",
    "Μίλησα με δικηγόρο για επίσημο παράπονο.",
    "A journalist is asking about this for a media enquiry."
  ]) {
    const result = assessPriority({ text });
    assert.equal(result.level, "urgent", text);
  }
});

// --- 28. False appointment substring -----------------------------------------------------------

test("[014-28] booking-word substrings inside unrelated words do not trigger appointment intent, EN/AR/EL true positives still work", () => {
  for (const text of ["I work in bookkeeping.", "Let me recall that detail.", "I read it in a textbook."]) {
    assert.equal(detectIntent(text).intents.includes("appointment"), false, text);
  }
  for (const text of ["I'd like to book a call next week.", "ممكن احجز موعد الخميس؟", "Θέλω να κλείσω ένα ραντεβού."]) {
    assert.equal(detectIntent(text).intents.includes("appointment"), true, text);
  }
});

// --- 29. RAG no-evidence behavior ---------------------------------------------------------------

test("[014-29] no approved-knowledge match yields a safe boundary statement, not an invented answer, EN/AR/EL", async () => {
  const CASES = {
    english: { msg: "Do you offer cryptocurrency custody services?", answer: "I don't have approved information confirming that service. I can check with the team if useful." },
    arabic: { msg: "هل بتقدموا خدمات حفظ عملات رقمية؟", answer: "ما عندي معلومة معتمدة تأكد هالخدمة. فيني تأكد مع الفريق إذا حاب." },
    greek: { msg: "Προσφέρετε υπηρεσίες φύλαξης κρυπτονομισμάτων;", answer: "Δεν έχω εγκεκριμένη πληροφορία που να το επιβεβαιώνει. Μπορώ να ελέγξω με την ομάδα αν θέλετε." }
  };
  for (const [locale, { msg, answer }] of Object.entries(CASES)) {
    const tools = { searchApprovedKnowledge: { run: async () => ({ ok: true, status: "no_evidence", data: [] }) } };
    const decide = scriptedDecider([
      { type: "tool", tool: "searchApprovedKnowledge", args: { query: msg } },
      { type: "respond", text: answer }
    ]);
    const result = await runAgentTurn(agentContextFor(locale, msg), { decideNextStep: decide, tools });
    assert.equal(result.outcome, "responded", locale);
    assert.ok(questionCount(result.response) <= 1, locale);
    assert.equal(result.response, answer, locale);
  }
});

// --- 30. Provider/model failure ------------------------------------------------------------------

test("[014-30] a decision/model failure produces a localized deterministic fallback, no crash, EN/AR/EL", async () => {
  const EXPECT = { english: /./, arabic: /[؀-ۿ]/, greek: /[Ͱ-Ͽ]/ };
  for (const locale of ["english", "arabic", "greek"]) {
    const decide = async () => { throw new Error("model provider unavailable"); };
    const result = await runAgentTurn(agentContextFor(locale, "What is the price?"), { decideNextStep: decide, tools: {} });
    assert.equal(result.outcome, "decision_failed", locale);
    assert.equal(typeof result.response, "string", locale);
    assert.ok(result.response.length > 0, locale);
    assert.match(result.response, EXPECT[locale], locale);
  }
});

// --- Telemetry signals (013 gap, addressed narrowly in 014) ---------------------------------------

test("[014-telemetry] languageSignalsFrom flags a real mismatch but stays null when there is nothing meaningful to compare", () => {
  assert.deepEqual(
    languageSignalsFrom("arabic", "This is an English-only reply."),
    { expectedLocale: "arabic", detectedResponseLocale: "english", languageMismatch: true }
  );
  assert.deepEqual(
    languageSignalsFrom("arabic", "تأسيس الشركة في قبرص بياخد حوالي خمس أيام عمل."),
    { expectedLocale: "arabic", detectedResponseLocale: "arabic", languageMismatch: false }
  );
  assert.deepEqual(
    languageSignalsFrom("unknown", "anything"),
    { expectedLocale: "unknown", detectedResponseLocale: null, languageMismatch: null }
  );
  assert.deepEqual(
    languageSignalsFrom("english", ""),
    { expectedLocale: "english", detectedResponseLocale: null, languageMismatch: null }
  );
});

test("[014-telemetry] questionSignalsFrom emits raw counts, not a semantic 'unnecessary' verdict", () => {
  assert.deepEqual(questionSignalsFrom("What is your budget?", "responded"), { questionCount: 1, hasQuestion: true, clarificationRequested: false });
  assert.deepEqual(questionSignalsFrom("What is your budget?", "clarified"), { questionCount: 1, hasQuestion: true, clarificationRequested: true });
  assert.deepEqual(questionSignalsFrom("No questions here.", "responded"), { questionCount: 0, hasQuestion: false, clarificationRequested: false });
});

// --- handover default-message localization (small fix made in this ticket) ------------------------

test("[014-fix] proposeHandover's default customer message is localized, not English-only, EN/AR/EL", () => {
  for (const [language, expect] of [["arabic", /شاركت هذا مع فريق الشركة/], ["greek", /μοιράστηκα με την αρμόδια ομάδα/], ["english", /shared this with the appropriate the business team/]]) {
    const handover = createHandover({ input: "please connect me to a specialist", language });
    assert.match(handover.messages.customerMessage, expect, language);
  }
});
