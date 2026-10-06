const assert = require("node:assert/strict");
const { test } = require("node:test");
const { extractCustomerName, extractCustomerNeed, prepareInboundMessage, recordHistory, routeMessageResult } = require("./messageRouter.js");
const { getConsentState, hasFollowUpPermission } = require("./leadQualification.js");

test("customer names are extracted from common English and Arabic introductions", () => {
  assert.equal(extractCustomerName("My name is Rami"), "Rami");
  assert.equal(extractCustomerName("I'm Rami"), "Rami");
  assert.equal(extractCustomerName("اسمي حسن"), "حسن");
  assert.equal(extractCustomerName("أنا اسمي ليلى"), "ليلى");
  assert.equal(extractCustomerName("كيفك"), null);
  assert.equal(extractCustomerName("مرحبا، شو خدماتكم؟"), null);
  assert.equal(extractCustomerName("مرحبا، مين أنت وشو بتعمل؟"), null);
  assert.equal(extractCustomerName("My name is Rami, same WhatsApp number"), "Rami");
  assert.equal(extractCustomerName("اسمي حسن ورقمي نفس الواتساب"), "حسن");
  assert.equal(extractCustomerName("Με λένε Νίκο"), "Νίκο");
  assert.equal(extractCustomerName("Είμαι ο Νίκος"), "Νίκος");
  assert.equal(extractCustomerName("Είμαι ο ιδιοκτήτης εταιρείας"), null);
  assert.equal(extractCustomerName("Είμαι η υπεύθυνη του έργου"), null);
  assert.equal(extractCustomerName("Είμαι ο πελάτης της εταιρείας"), null);
  assert.equal(extractCustomerName("Γεια σας, τι υπηρεσίες προσφέρετε;"), null);
  assert.equal(extractCustomerName("Ποιοι είστε;"), null);
  assert.equal(extractCustomerName("I am still upset"), null);
  assert.equal(extractCustomerName("أنا لسا متضايق"), null);
  assert.equal(extractCustomerName("Είμαι ακόμα αναστατωμένος"), null);
});

test("clear name introductions are saved even when the message also gives contact context", async () => {
  for (const [text, expected] of [
    ["My name is Rami, same WhatsApp number", "Rami"],
    ["اسمي حسن ورقمي نفس الواتساب", "حسن"]
  ]) {
    const user = { id: `name-${Math.random()}`, profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(user.profile.name, expected, text);
    assert.equal(result.metadata.customerNameCaptured, true, text);
    assert.match(result.response, new RegExp(expected));
  }
});

test("a language switch into Greek captures an explicit name and persists it to the contact", async () => {
  const user = {
    id: "greek-name@s.whatsapp.net",
    profile: {},
    history: [{ message: "What services do you offer?", response: "How can I help?" }]
  };
  const persistedProfiles = [];
  const store = integrationStore(user);
  store.updateUser = async (_id, update) => {
    update(user);
    persistedProfiles.push(structuredClone(user.profile));
    return user;
  };

  const result = await routeMessageResult({ userId: user.id, text: "Με λένε Νίκο", store });

  assert.equal(result.metadata.intent.language, "greek");
  assert.equal(user.profile.name, "Νίκο");
  assert.equal(user.profile.nameSource, "customer_stated");
  assert.equal(persistedProfiles.at(-1).name, "Νίκο");
  assert.match(result.response, /Χαίρω πολύ, Νίκο/);
  assert.equal(result.metadata.customerNameCaptured, true);
});

test("Greek greetings, service questions, and role descriptions are not captured as contact names", async () => {
  for (const text of ["Γεια σας", "Γεια σας, τι υπηρεσίες προσφέρετε;", "Ποιοι είστε;", "Είμαι ο ιδιοκτήτης εταιρείας", "Είμαι η υπεύθυνη του έργου", "Είμαι ο πελάτης της εταιρείας"]) {
    const user = { id: `greek-not-name-${Math.random()}`, profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(user.profile.name, undefined, text);
    assert.notEqual(result.metadata.customerNameCaptured, true, text);
  }
});

test("company formation mentioning investment stays informational unless it asks for advice", async () => {
  const user = { id: "formation-investment", profile: {}, history: [] };
  const result = await routeMessageResult({ userId: user.id, text: "I want to register an investment company in Cyprus", store: integrationStore(user) });
  assert.equal(result.metadata.intent.primary, "company_formation");
  assert.equal(result.shouldUseAi, true);
  assert.equal(result.metadata.handover, undefined);
});

test("Syrian investment-company registration request reaches the information answer flow", async () => {
  const user = { id: "syrian-formation-investment", profile: {}, history: [] };
  const result = await routeMessageResult({ userId: user.id, text: "بدي اسجل شركة استثمار ب قبرص", store: integrationStore(user) });
  assert.ok(result.metadata.intent.intents.includes("company_formation"));
  assert.ok(result.metadata.intent.intents.includes("investment"));
  assert.equal(result.shouldUseAi, true);
  assert.equal(result.metadata.handover, undefined);
});

test("a formation request that also mentions investment creates only one company-formation intake", async () => {
  const user = { id: "formation-single-intake", profile: {}, history: [] };
  const prepared = await prepareInboundMessage({ userId: user.id, incoming: "بدي اسجل شركة استثمار ب قبرص", user, store: integrationStore(user) });
  assert.deepEqual(Object.keys(prepared.metadata.opportunityIntakes), ["company_formation"]);
  assert.equal(prepared.metadata.opportunityIntake.type, "company_formation");
});

test("credential-bearing business messages are excluded from profile, intake, summaries, and saved turn payloads", async () => {
  const user = { id: "privacy-company-setup", profile: {}, history: [] };
  const store = integrationStore(user);
  const result = await routeMessageResult({ userId: user.id, text: "My name is Rami. Password: SecretPhrase-81. Help me set up a company in Cyprus", store });
  assert.ok(result.metadata.safety.risks.includes("privacy"));
  assert.equal(result.shouldUseAi, true);
  assert.match(result.metadata.privacySafeQuestion, /Help me set up a company in Cyprus/);
  assert.equal(user.profile.name, undefined);
  assert.equal(user.profile.need, undefined);
  assert.equal(user.profile.opportunityIntake, undefined);
  assert.equal(user.profile.opportunityIntakes, undefined);
  assert.doesNotMatch(JSON.stringify(user.profile), /SecretPhrase-81|Rami/);
  await recordHistory(store, user.id, "My name is Rami. Password: SecretPhrase-81. Help me set up a company in Cyprus", result.response, { metadata: result.metadata });
  assert.equal(user.history.at(-1).message, "[message omitted: potentially sensitive credentials]");
  assert.doesNotMatch(JSON.stringify(user.history.at(-1)), /SecretPhrase-81|Rami/);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "opportunity_intake"), false);
});

test("IBAN-bearing company intake is excluded from profile, intake, and transcript persistence", async () => {
  const user = { id: "iban-company-setup", profile: {}, history: [] };
  const result = await routeMessageResult({ userId: user.id, text: "Help me set up a company in Cyprus. IBAN: CY17 0020 0128 0000 0012 0052 7600", store: integrationStore(user) });
  assert.ok(result.metadata.safety.risks.includes("privacy"));
  assert.equal(user.profile.opportunityIntake, undefined);
  assert.equal(user.profile.opportunityIntakes, undefined);
  assert.doesNotMatch(JSON.stringify(user.profile), /CY17|0020 0128/);
  assert.doesNotMatch(JSON.stringify(user.history), /CY17|0020 0128/);
});

test("simple acknowledgements and declines do not invoke knowledge retrieval routing", async () => {
  for (const [text, language] of [["تمام", "arabic"], ["لا شكرا", "arabic"], ["No thanks", "english"], ["Ευχαριστώ", "greek"]]) {
    const user = { id: `ack-${Math.random()}`, profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(result.shouldUseAi, false, text);
    assert.equal(result.metadata.intent.language, language, text);
    assert.equal(result.metadata.handover, undefined, text);
  }
});

test("yes after a specialist offer creates a consent-linked handover using the prior validated intent", async () => {
  const offerAt = new Date().toISOString();
  const user = {
    id: "specialist-consent",
    profile: {},
    history: [{
      id: "company-offer-turn",
      at: offerAt,
      message: "I need help setting up an investment company",
      response: "Would you like me to connect you with a specialist?",
      metadata: { intent: { primary: "company_formation", intents: ["company_formation", "pricing"], language: "english" }, specialistOffer: { consentRequired: true, offeredAt: offerAt } }
    }]
  };
  const result = await routeMessageResult({ userId: user.id, text: "yes", store: integrationStore(user) });
  assert.equal(result.shouldUseAi, false);
  assert.equal(result.metadata.specialistFollowUp.consented, true);
  assert.equal(user.profile.specialistFollowUp.consented, true);
  assert.match(result.response, /recorded your request/i);
  assert.match(result.response, /share the name you’d like included.*optional/i);
  assert.doesNotMatch(result.response, /what name should i include/i);
  assert.doesNotMatch(result.response, /shared your request|will (?:contact|follow up)|soon/i);
  assert.equal(result.metadata.handover.routing.department, "corporate_services");
  assert.equal(result.metadata.specialistFollowUp.offerSourceTurnId, "company-offer-turn");
  assert.ok(result.metadata.handover.routing.matchedIntents.includes("company_formation"));
  assert.ok(user.workflowCalls.some(([kind]) => kind === "handover"));
});

test("consented handover shares only the linked inquiry, stated name, and WhatsApp contact", async () => {
  const offerAt = new Date().toISOString();
  const user = {
    id: "35799123456@s.whatsapp.net",
    phone: "+35799123456",
    profile: {
      name: "Samir Nassar",
      nameSource: "customer_stated",
      company: "Private Holdings Ltd",
      email: "samir@example.com",
      position: "Director",
      country: "Cyprus",
      need: "Unrelated old request",
      opportunityIntake: { type: "investment", data: { project: "Confidential project", budget: "€4m", decisionMakers: "Board" } },
      leadQualification: { total: 99, status: "qualified", dimensions: { authority: 5, budget: 5 } }
    },
    history: [{
      id: "linked-inquiry-turn",
      at: offerAt,
      message: "I’m exploring a mixed-use development in Cyprus and would like an initial specialist discussion.",
      response: "Would you like me to ask a Refalco specialist to follow up?",
      metadata: { intent: { primary: "development", intents: ["development", "investment", "real_estate"], language: "english" }, specialistOffer: { consentRequired: true, offeredAt: offerAt } }
    }]
  };
  const result = await routeMessageResult({ userId: user.id, text: "Yes", store: integrationStore(user) });
  const handoverCall = user.workflowCalls.find(([kind]) => kind === "handover");
  const savedSummary = handoverCall[2].summary;
  assert.equal(result.metadata.specialistFollowUp.offerSourceTurnId, "linked-inquiry-turn");
  assert.equal(result.metadata.specialistFollowUp.offerSourceTurnId, "linked-inquiry-turn");
  assert.equal(savedSummary.sharingScope, "current_inquiry_only");
  assert.equal(savedSummary.need, user.history[0].message);
  assert.equal(savedSummary.customer.name, "Samir Nassar");
  assert.equal(savedSummary.customer.whatsappContact, user.id);
  assert.equal(savedSummary.customer.company, null);
  assert.equal(savedSummary.customer.email, null);
  assert.equal(savedSummary.customer.position, null);
  assert.equal(savedSummary.customer.country, null);
  assert.equal(savedSummary.qualification, null);
  assert.equal(savedSummary.requirements, null);
  assert.equal(savedSummary.structuredRequirements, null);
  assert.equal(savedSummary.budget, null);
  assert.equal(savedSummary.decisionAuthority, null);
  assert.equal(savedSummary.secondaryIntents.length, 0);
  const serialized = JSON.stringify(savedSummary);
  assert.doesNotMatch(serialized, /Private Holdings|samir@example|Unrelated old request|Confidential project|4m|Board|qualified/);
  assert.match(serialized, /mixed-use development in Cyprus/);
});

test("a narrower sharing request is acknowledged and stored in English, Syrian Arabic, and Greek", async () => {
  const cases = [
    ["Please share only the project summary, not the rest of the conversation.", "english", /summary of this project inquiry|without sharing the rest/i],
    ["اسمي Samir Nassar، شاركوا ملخص المشروع بس، مو باقي تفاصيل المحادثة.", "arabic", /ملخّص استفسارك|بدون باقي المحادثة/],
    ["Παρακαλώ κοινοποιήστε μόνο τη σύνοψη του έργου, όχι το υπόλοιπο της συνομιλίας.", "greek", /μόνο σύνοψη|όχι το υπόλοιπο/i]
  ];
  for (const [text, language, expected] of cases) {
    const user = {
      id: `scope-correction-${language}`,
      profile: {
        handover: { required: true, status: "open", summary: { format: "REFAL LEAD SUMMARY", need: "Current project inquiry", sharingScope: "current_inquiry_only" } }
      },
      history: [{ message: "I asked for specialist follow-up.", response: "I’ve logged your request. What name should I include with it?", metadata: { intent: { language }, specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } }]
    };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.match(result.response, expected, language);
    assert.equal(user.profile.handover.summary.sharingScope, "current_inquiry_only", language);
    assert.equal(user.history.at(-1).metadata.handoverScope.value, "current_inquiry_only", language);
    assert.equal(user.workflowCalls.filter(([kind]) => kind === "handover").length, 0, "scope clarification must not create or resend a handover");
    assert.doesNotMatch(result.response, /Nice to meet you|تشرفت بك|Χαίρω πολύ|How can I help/i);
  }
});

test("a narrower summary request cannot override an explicit no-contact revocation", async () => {
  const user = {
    id: "scope-plus-revocation",
    profile: { handover: { required: true, status: "open", summary: { sharingScope: "current_inquiry_only", need: "Project inquiry" } } },
    history: [{ message: "I asked for a specialist follow-up.", response: "I’ve logged your request.", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up" } } }]
  };
  const result = await routeMessageResult({
    userId: user.id,
    text: "Share only the project summary, not the rest of the conversation. Do not contact me.",
    store: integrationStore(user)
  });
  assert.match(result.response, /won’t request specialist follow-up/i);
  assert.equal(result.metadata.handoverScope, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
});

test("a clear reference to the earlier specialist question records consent after a simple thank-you", async () => {
  const offerAt = new Date().toISOString();
  const user = {
    id: "referenced-specialist-consent",
    profile: {},
    history: [
      { id: "offer-turn", at: offerAt, message: "I need help with a company setup", response: "Would you like the team to follow up?", metadata: { intent: { intents: ["company_formation"], language: "english" }, specialistOffer: { consentRequired: true, offeredAt: offerAt } } },
      { id: "thanks-turn", at: offerAt, message: "تمام، شكراً.", response: "على الرحب والسعة.", metadata: { intent: { intents: ["small_talk"], language: "arabic" } } }
    ]
  };
  const result = await routeMessageResult({ userId: user.id, text: "I meant yes to your last question. What is the main thing to prepare?", store: integrationStore(user) });
  assert.equal(result.metadata.specialistFollowUp.consented, true);
  assert.equal(result.metadata.specialistFollowUp.trackedOffer, true);
  assert.equal(result.metadata.specialistFollowUp.offerSourceTurnId, "offer-turn");
  assert.ok(user.workflowCalls.some(([kind, _id, state]) => kind === "consent" && state === "granted"));
  assert.ok(user.workflowCalls.some(([kind]) => kind === "handover"));
  assert.match(result.response, /recorded your request/i);
});

test("a contextual yes cannot revive an old specialist offer or cross a substantive topic change", async () => {
  const stale = { id: "stale-offer", at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), message: "Question", response: "Would you like a specialist to follow up?", metadata: { specialistOffer: { consentRequired: true } } };
  const changed = { id: "new-topic", at: new Date().toISOString(), message: "Can you explain your other services?", response: "...", metadata: {} };
  for (const history of [[stale], [{ ...stale, at: new Date().toISOString(), metadata: { specialistOffer: { consentRequired: true, offeredAt: new Date().toISOString() } } }, changed]]) {
    const user = { id: `stale-offer-${Math.random()}`, profile: {}, history };
    const result = await routeMessageResult({ userId: user.id, text: "I meant yes to your earlier question.", store: integrationStore(user) });
    assert.equal(result.metadata.specialistFollowUp, undefined);
    assert.equal(result.handover, undefined);
  }
});

test("a plain yes cannot accept an expired tracked specialist offer", async () => {
  const oldOfferAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const user = {
    id: "expired-plain-yes",
    profile: {},
    history: [{
      id: "expired-offer-turn",
      at: oldOfferAt,
      message: "I need help with company formation.",
      response: "Would you like a specialist to follow up?",
      metadata: { intent: { intents: ["company_formation"], language: "english" }, specialistOffer: { consentRequired: true, offeredAt: oldOfferAt } }
    }]
  };
  const result = await routeMessageResult({ userId: user.id, text: "Yes", store: integrationStore(user) });
  assert.equal(result.metadata.specialistFollowUp, undefined);
  assert.equal(result.metadata.handover, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
});

test("contextual consent references are recognized in Syrian Arabic and Greek", async () => {
  for (const [text, language] of [["كنت أقصد نعم على سؤالك اللي قبل.", "arabic"], ["Εννοούσα ναι στην προηγούμενη ερώτηση.", "greek"]]) {
    const offerAt = new Date().toISOString();
    const user = { id: `localized-context-${Math.random()}`, profile: {}, history: [{ id: "offer-turn", at: offerAt, message: "Earlier request", response: "Specialist offer", metadata: { intent: { intents: ["company_formation"], language }, specialistOffer: { consentRequired: true, offeredAt: offerAt } } }, { id: "thanks-turn", at: offerAt, message: language === "arabic" ? "تمام، شكراً" : "Ευχαριστώ", response: "You are welcome", metadata: {} }] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(result.metadata.specialistFollowUp.consented, true, text);
    assert.equal(result.metadata.specialistFollowUp.offerSourceTurnId, "offer-turn", text);
    assert.equal(result.metadata.intent.language, language, text);
  }
});

test("specialist consent clears a legacy greeting-name and makes name sharing optional", async () => {
  const offerAt = new Date().toISOString();
  const user = {
    id: "name-and-handover",
    profile: { name: "مرحبا، شو خدماتكم", nameSource: "customer_stated", whatsappName: "WhatsApp profile" },
    history: [{ id: "name-offer-turn", at: offerAt, message: "Can you connect me with a specialist?", response: "Would you like the team to follow up?", metadata: { intent: { intents: ["company_formation"], language: "arabic" }, specialistOffer: { consentRequired: true, offeredAt: offerAt } } }]
  };
  const store = integrationStore(user);
  const result = await routeMessageResult({ userId: user.id, text: "نعم", store });
  assert.match(result.response, /الاسم اللي بدك ياه ينضاف.*اختياري/);
  assert.equal(user.profile.name, undefined);
  assert.equal(user.profile.handover.required, true);
  assert.equal(user.workflowCalls.filter(([kind]) => kind === "handover").length, 1);
  const emailAlerts = user.workflowCalls.filter(([kind]) => kind === "notification");
  assert.equal(emailAlerts.length, 1);
  assert.equal(emailAlerts[0][1].kind, "handover_review");

  const captured = await routeMessageResult({ userId: user.id, text: "Hasan", store, existingUser: user });
  assert.equal(user.profile.name, "Hasan");
  assert.equal(user.profile.nameSource, "customer_stated");
  assert.equal(captured.metadata.customerNameCaptured, true);
  assert.match(captured.response, /أضفت اسمك/);
  assert.equal(user.workflowCalls.filter(([kind]) => kind === "handover").length, 1, "name capture must not create a duplicate handover");
});

test("natural follow-up and connection requests create one consented handover", async () => {
  for (const [index, text] of [
    ["follow-up", "Yes, please have a specialist follow up."],
    ["connect", "Please connect me to someone if the bot can't inspect the attachment."]
  ]) {
    const user = { id: `natural-handover-${index}`, profile: {}, history: [] };
    const store = integrationStore(user);
    const first = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
    assert.equal(first.metadata.specialistFollowUp?.consented, true, text);
    assert.ok(first.handover, text);
    assert.match(first.response, /recorded/i, text);
    assert.doesNotMatch(first.response, /what name should I include/i, text);
    assert.equal(user.workflowCalls.filter(([kind]) => kind === "handover").length, 1, text);

    const repeated = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
    assert.match(repeated.response, /already recorded/i, text);
    assert.equal(user.workflowCalls.filter(([kind]) => kind === "handover").length, 1, "repeated consent must not duplicate an open handover");
  }
});

test("Arabic identity and unclear project messages route to relevant local replies", async () => {
  for (const [text, expected] of [
    ["مرحبا، مين أنت وشو بتعمل؟", /الوكيل الرقمي للأعمال في مجموعة ريفالكو/],
    ["أهلاً، من أنت؟", /الوكيل الرقمي للأعمال في مجموعة ريفالكو/],
    ["عندي فكرة مشروع بقبرص، بس مو متأكد إذا بتناسبني", /ما نوع المشروع الذي تفكر فيه/],
    ["أفكر بمشروع في قبرص ولا أعرف إن كان مناسباً", /ما نوع المشروع الذي تفكر فيه/]
  ]) {
    const user = { id: `arabic-${Math.random()}`, profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.match(result.response, expected, text);
    assert.equal(user.profile.name, undefined, text);
    assert.equal(result.metadata.handover, undefined, text);
    assert.equal(result.shouldUseAi, false, text);
  }
});

test("identity questions in English, Greek, and Arabic receive REFAL's local introduction", async () => {
  const cases = [
    ["Who are you?", "english", /REFAL, REFALCO GROUP’s digital business agent/],
    ["What do you do?", "english", /REFAL, REFALCO GROUP’s digital business agent/],
    ["Ποιοι είστε;", "greek", /είμαι η REFAL/],
    ["Ποια είστε;", "greek", /είμαι η REFAL/],
    ["مين أنت؟", "arabic", /أنا رِفال، الوكيل الرقمي للأعمال/],
    ["شو بتعملوا؟", "arabic", /أنا رِفال، الوكيل الرقمي للأعمال/]
  ];

  for (const [text, language, expectedReply] of cases) {
    const user = { id: `identity-${Math.random()}`, profile: {}, history: [] };
    let retrievalCalls = 0;
    const store = integrationStore(user);
    store.searchKnowledge = async () => { retrievalCalls += 1; return []; };

    const result = await routeMessageResult({ userId: user.id, text, store });

    assert.equal(result.metadata.intent.language, language, text);
    assert.equal(result.metadata.intent.primary, "agent_identity", text);
    assert.match(result.response, expectedReply, text);
    assert.equal(result.shouldUseAi, false, text);
    assert.equal(retrievalCalls, 0, text);
  }
});

test("mentioning Refalco in a services question does not trigger the identity introduction", async () => {
  const user = { id: "services-not-identity", profile: {}, history: [] };
  const result = await routeMessageResult({
    userId: user.id,
    text: "What services does Refalco offer?",
    store: integrationStore(user)
  });

  assert.equal(result.shouldUseAi, true);
  assert.ok(result.metadata.intent.intents.includes("services"));
  assert.doesNotMatch(result.response, /digital business agent/);
});

test("service and pricing questions remain informational and capture no name", async () => {
  for (const text of [
    "بدي أعرف بشكل عام شو خدماتكم، وما بدي احجز موعد حالياً.",
    "مرحبا، شو خدماتكم؟", "ممكن أعرف شو بتقدموا؟", "كم تكلفة تأسيس شركة بقبرص؟", "قديش رسوم إنشاء شركة في قبرص؟"
  ]) {
    const user = { id: `arabic-${Math.random()}`, profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(result.shouldUseAi, true, text);
    assert.equal(user.profile.name, undefined, text);
    assert.ok(result.metadata.intent.intents.includes(text.includes("تكلفة") || text.includes("رسوم") ? "pricing" : "services"), text);
    assert.equal(result.metadata.handover, undefined, text);
  }
});

test("a comparison objection does not swallow a direct package-price question", async () => {
  const user = { id: "comparison-price-followup", profile: {}, history: [] };
  const result = await routeMessageResult({
    userId: user.id,
    text: "I'm still comparing options, but is the €999 package price final or case-specific?",
    store: integrationStore(user),
    existingUser: user
  });
  assert.equal(result.shouldUseAi, true);
  assert.ok(result.metadata.intent.intents.includes("pricing"));
  assert.equal(result.metadata.objection, undefined);
});

test("a stored no-pressure preference does not suppress a direct Greek timeline question", async () => {
  const user = {
    id: "no-pressure-greek-question",
    profile: { conversationPreferences: { noProactiveBookingOrContact: true } },
    history: []
  };
  const result = await routeMessageResult({
    userId: user.id,
    text: "Πόσος χρόνος χρειάζεται συνήθως μέχρι να ολοκληρωθεί η σύσταση;",
    store: integrationStore(user), existingUser: user
  });
  assert.equal(result.shouldUseAi, true);
  assert.equal(result.response, "Ελέγχω τις εγκεκριμένες πληροφορίες της Refalco για εσάς.");
});

test("a hypothetical result for a new customer's case does not trigger existing-client escalation", async () => {
  const user = { id: "hypothetical-case-question", profile: {}, history: [] };
  const store = integrationStore(user);
  const result = await routeMessageResult({
    userId: user.id,
    text: "Are you describing an available service or promising a specific result for my case?",
    store,
    existingUser: user
  });
  assert.equal(result.metadata.priority.triggers.includes("existing_client"), false);
  assert.equal(result.metadata.existingClientVerification, undefined);
  assert.equal(result.metadata.specialistOffer, undefined);
  assert.equal(result.handover, undefined);
});

test("language follows each current message across English, Greek, and Arabic turns", async () => {
  const user = { id: "switching-user", profile: {}, history: [] };
  const store = integrationStore(user);
  const turns = [
    ["Hello", "english", /REFALCO GROUP/], ["Γεια σας", "greek", /REFAL/], ["مرحبا", "arabic", /ريفالكو/], ["Hello there", "english", /REFALCO GROUP/]
  ];
  for (const [text, language, replyPattern] of turns) {
    const result = await routeMessageResult({ userId: user.id, text, store });
    assert.equal(result.metadata.intent.language, language);
    assert.match(result.response, replyPattern, text);
    assert.equal(user.profile.name, undefined);
  }
});

test("an explicit language-switch request is acknowledged in the requested language without retrieval", async () => {
  const user = { id: "requested-language-switch", profile: {}, history: [] };
  const store = integrationStore(user);
  let retrievalCalls = 0;
  store.searchKnowledge = async () => { retrievalCalls += 1; return []; };
  const result = await routeMessageResult({ userId: user.id, text: "Actually, can we continue in Greek?", store });
  assert.equal(result.shouldUseAi, false);
  assert.equal(result.metadata.intent.language, "greek");
  assert.match(result.response, /συνεχίσουμε στα ελληνικά/);
  assert.equal(retrievalCalls, 0);
  assert.equal(user.profile.need, undefined);
});

test("worker can reuse inbound preparation instead of persisting route state twice", async () => {
  const user = { id: "prepared-once", profile: {}, history: [] };
  let stateWrites = 0;
  const store = integrationStore(user);
  const updateUser = store.updateUser;
  store.updateUser = async (...args) => { stateWrites += 1; return updateUser(...args); };
  const preparedInbound = await prepareInboundMessage({ userId: user.id, incoming: "What services does Refalco offer?", user, store });
  const result = await routeMessageResult({ userId: user.id, text: "What services does Refalco offer?", store, existingUser: user, preparedInbound });
  assert.equal(result.shouldUseAi, true);
  assert.equal(stateWrites, 1);
});

test("unrelated turns do not advance or re-emit a stale opportunity intake", async () => {
  const legacyIntake = { type: "company_formation", status: "in_progress", data: { businessActivity: "old context" } };
  for (const text of ["Hi", "مرحبا، شو خدماتكم؟", "What is Refalco?"]) {
    const user = { id: `stale-intake-${Math.random()}`, profile: { opportunityIntake: structuredClone(legacyIntake) }, history: [] };
    const prepared = await prepareInboundMessage({ userId: user.id, incoming: text, user, store: integrationStore(user) });
    assert.equal(prepared.metadata.opportunityIntake, null, text);
    assert.deepEqual(prepared.metadata.opportunityIntakes, {}, text);
    assert.deepEqual(user.profile.opportunityIntake, legacyIntake, text);
  }
});

test("company activity is collected from a scoped recent follow-up in English, Arabic, and Greek", async () => {
  const cases = [
    ["english", "What will the company do?", "software consulting"],
    ["english-investment", "What will the company do?", "We invest our own funds"],
    ["arabic", "شو رح تعمل الشركة؟", "استشارات برمجية"],
    ["arabic-investment", "شو رح تعمل الشركة؟", "استثمار الشركة بأموالها الخاصة"],
    ["greek", "Με τι θα ασχολείται η εταιρεία;", "Συμβουλευτικές υπηρεσίες λογισμικού"]
  ];
  for (const [language, question, answer] of cases) {
    const intake = { type: "company_formation", status: "in_progress", data: {}, provenance: {}, updatedAt: new Date().toISOString(), missingFields: ["businessActivity"] };
    const user = { id: `activity-followup-${language}`, profile: { opportunityIntake: intake, opportunityIntakes: { company_formation: intake } }, history: [{ message: "I want to form a company", response: question }] };
    const prepared = await prepareInboundMessage({ userId: user.id, incoming: answer, user, store: integrationStore(user) });
    assert.equal(prepared.metadata.opportunityIntakes.company_formation.data.businessActivity, answer, language);
    assert.equal(prepared.metadata.opportunityIntake.data.businessActivity, answer, language);
    assert.equal(Object.keys(prepared.metadata.opportunityIntakes).length, 1, language);
  }
});

test("company activity continuation expires and does not capture a clear topic switch", async () => {
  const cases = [
    [new Date().toISOString(), "Can you explain visa requirements?"],
    [new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), "software consulting"]
  ];
  for (const [updatedAt, answer] of cases) {
    const intake = { type: "company_formation", status: "in_progress", data: {}, provenance: {}, updatedAt, missingFields: ["businessActivity"] };
    const user = { id: `activity-switch-${Math.random()}`, profile: { opportunityIntake: intake, opportunityIntakes: { company_formation: intake } }, history: [{ message: "I want to form a company", response: "What will the company do?" }] };
    const prepared = await prepareInboundMessage({ userId: user.id, incoming: answer, user, store: integrationStore(user) });
    assert.equal(prepared.metadata.opportunityIntakes.company_formation, undefined, answer);
  }
});

test("explicit customer service interest is saved as personal memory, not mistaken for a name", async () => {
  assert.equal(extractCustomerNeed("I'm interested in property management"), "property management");
  assert.equal(extractCustomerNeed("بدي مساعدة في إدارة العقارات"), "إدارة العقارات");
  const user = { id: "35799123456@s.whatsapp.net", profile: {}, history: [] };
  const store = {
    ensureUser: async () => user,
    updateUser: async (_id, update) => update(user),
    addHistory: async (_id, message, response) => { user.history.push({ message, response }); return user.history.at(-1); }
  };
  const result = await routeMessageResult({ userId: user.id, text: "I'm interested in property management", store });
  assert.equal(user.profile.need, "property management");
  assert.equal(user.profile.name, undefined);
  assert.equal(result.shouldUseAi, true);
});

test("كيفك receives natural Arabic small talk and answers first without a name prompt", async () => {
  const user = { id: "35799123456@s.whatsapp.net", profile: {}, history: [] };
  const store = {
    ensureUser: async () => user,
    addHistory: async (_id, message, response) => { user.history.push({ message, response }); return user.history.at(-1); }
  };
  const routed = await routeMessageResult({ userId: user.id, text: "كيفك", store });
  assert.match(routed.response, /الحمد لله/);
  assert.doesNotMatch(routed.response, /ما اسمك/);
  assert.doesNotMatch(routed.response, /https?:\/\/|Sources:/i);
  assert.equal(routed.shouldUseAi, false);
});

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

test("Greeklish no-pressure boundary is acknowledged in Greek and persisted", async () => {
  const user = { id: "greeklish-boundary", profile: {}, history: [] };
  const store = integrationStore(user);
  const text = "Den thelo na me piesis na kleiso rantevou i na doso stoicheia epikoinonias. Tha rotiso argotera an xreiastei.";
  const result = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
  assert.match(result.response, /Κατανοητό/);
  assert.equal(result.metadata.intent.language, "greek");
  assert.equal(user.profile.conversationPreferences.noProactiveBookingOrContact, true);
  assert.ok(user.workflowCalls.some(([kind, _id, state]) => kind === "consent" && state === "denied"));
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
});

test("Greeklish polite closure gets a short Greek response without invoking AI", async () => {
  const user = { id: "greeklish-closure", profile: {}, history: [] };
  const result = await routeMessageResult({
    userId: user.id,
    text: "Den exo kati allo gia tin ora. An xreiaso kati, tha to zitiso.",
    store: integrationStore(user),
    existingUser: user
  });
  assert.equal(result.shouldUseAi, false);
  assert.equal(result.metadata.intent.language, "greek");
  assert.match(result.response, /Είμαι εδώ αν χρειαστείτε κάτι άλλο/);
  assert.doesNotMatch(result.response, /\?/);
});

test("repeating that the customer will ask later persists a no-pressure preference", async () => {
  const user = { id: "greeklish-ask-later", profile: {}, history: [] };
  const store = integrationStore(user);
  const text = "An thelo kati sigkekrimeno, tha to zitiseis.";
  const first = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
  await recordHistory(store, user.id, text, first.response, { metadata: first.metadata });
  assert.equal(user.profile.conversationPreferences.noProactiveBookingOrContact, true);

  const next = await routeMessageResult({
    userId: user.id,
    text: "We need a large land development and a strategic partnership",
    store,
    existingUser: user
  });
  assert.equal(next.metadata.specialistOffer, undefined);
  assert.doesNotMatch(next.response, /specialist|follow up|book a call/i);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
});

test("a customer who says they will ask about booking later gets no booking or name prompt", async () => {
  const user = { id: "english-book-later", profile: {}, history: [] };
  const store = integrationStore(user);
  const text = "I'll keep comparing for now and won't share contact details yet — I can ask about booking later if I decide to move ahead.";
  const result = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
  assert.equal(result.shouldUseAi, false);
  assert.equal(user.profile.conversationPreferences.noProactiveBookingOrContact, true);
  assert.match(result.response, /whenever you’re ready/i);
  assert.doesNotMatch(result.response, /what(?:'s| is) your name|send the new day|book a time/i);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
});

test("Syrian Arabic booking-later preference is acknowledged without qualification", async () => {
  const user = { id: "arabic-book-later", profile: {}, history: [] };
  const text = "لسا عم قارن وما بدي احجز هلأ، إذا احتجت شي رح اسأل بعدين.";
  const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user), existingUser: user });
  assert.equal(result.shouldUseAi, false);
  assert.equal(user.profile.conversationPreferences.noProactiveBookingOrContact, true);
  assert.match(result.response, /إذا قررت|جاهز/);
  assert.doesNotMatch(result.response, /شو اسمك|احجز موعد/);
});

test("an exact customer echo of the previous assistant answer gets a neutral clarification reply", async () => {
  const echoed = "Δεν έχω επιβεβαιωμένη πληροφορία για το αν τα 999 ευρώ είναι σταθερή τιμή για όλους ή εκτίμηση ανά περίπτωση. Το μόνο που είναι επιβεβαιωμένο είναι το πακέτο των 999 ευρώ με τέσσερις μήνες εταιρικής γραμματείας και εγγεγραμμένης διεύθυνσης.";
  const user = { id: "assistant-echo", profile: {}, history: [{ message: "Price question", response: echoed }] };
  const result = await routeMessageResult({ userId: user.id, text: echoed, store: integrationStore(user), existingUser: user });
  assert.equal(result.shouldUseAi, false);
  assert.notEqual(result.metadata.safety?.restricted, true);
  assert.match(result.response, /Είμαι εδώ αν θέλετε να διευκρινίσω/);
  assert.doesNotMatch(result.response, /νομικό καθεστώς|εγγραφή εταιρειών/);
});

test("recordHistory runs independent post-turn workflow writes concurrently", async () => {
  let active = 0;
  let peak = 0;
  const delayWrite = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 35));
    active -= 1;
  };
  const store = {
    addHistory: async () => ({ id: "turn-1" }),
    saveQualification: delayWrite,
    saveIntents: delayWrite,
    createHandover: delayWrite,
    createPriorityAlert: delayWrite
  };
  await recordHistory(store, "test-contact", "I need a specialist", "I can connect you", {
    metadata: {
      qualification: { dimensions: {} },
      intent: { primary: "investment", intents: ["investment"] },
      priority: { level: "high", triggers: ["institutional_investment"] },
      specialistFollowUp: { consented: true, purpose: "specialist_follow_up", offerSourceTurnId: "offer-1" },
      handover: { routing: { department: "investment", priority: "high" } }
    }
  });
  assert.equal(peak, 4, "all independent writes should overlap after turn creation");
});

test("REFAL-AGENT-011: recordHistory stores a real deterministic booking confirmation as-is only when metadata.verifiedBookingConfirmed is true", async () => {
  // Before this ticket, recordHistory had no way to mark a booking claim
  // verified at all (unlike handover, which already had
  // allowVerifiedHandoverClaim): booking.js's own deterministic confirmation
  // text matches BOOKING_ACTION_CLAIM, so it was always swapped out for a
  // generic fallback in the stored history — even though the customer had
  // already received the real confirmation over WhatsApp. This proves the
  // fix (hasVerifiedBookingClaim) and locks in the un-fixed case too, so a
  // future change can't silently widen what counts as "verified".
  const confirmation = "Confirmed. Your meeting is booked for 6 Oct 2026, 10:30. Google Meet: https://meet.google.com/abc-defg-hij";

  const unverifiedUser = { id: "booking-unverified", profile: {}, history: [] };
  await recordHistory(integrationStore(unverifiedUser), unverifiedUser.id, "book me a meeting", confirmation, { metadata: {} });
  assert.notEqual(unverifiedUser.history[0].response, confirmation, "without the verified flag the claim must still be rejected");

  const verifiedUser = { id: "booking-verified", profile: {}, history: [] };
  await recordHistory(integrationStore(verifiedUser), verifiedUser.id, "book me a meeting", confirmation, { metadata: { verifiedBookingConfirmed: true } });
  assert.equal(verifiedUser.history[0].response, confirmation, "a real, store-confirmed booking must be stored as the customer actually saw it");
});

test("recordHistory strips an unconsented handover before persisting the turn", async () => {
  const user = { id: "handover-needs-consent", profile: {}, history: [] };
  const store = integrationStore(user);
  const { turn } = await recordHistory(store, user.id, "A substantial project", "I can help with the basics.", {
    metadata: { handover: { routing: { department: "development", priority: "high" }, summary: { need: "project" } } }
  });
  assert.equal(turn.metadata.handover, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "notification"), false);
});

test("routeMessageResult offers consent-based follow-up for a high-value multi-intent lead without persisting early", async () => {
  const user = { id: "35799123456@s.whatsapp.net", phone: "35799123456", profile: {}, history: [] };
  const result = await routeMessageResult({
    userId: user.id,
    text: "We need a large land development and a strategic partnership",
    store: integrationStore(user)
  });
  assert.equal(result.shouldUseAi, false);
  assert.equal(result.metadata.intent.isMultiIntent, true);
  assert.ok(result.metadata.intent.intents.includes("land_development"));
  assert.ok(result.metadata.intent.intents.includes("partnership"));
  assert.ok(result.metadata.qualification.dimensions && Object.keys(result.metadata.qualification.dimensions).length === 6);
  assert.equal(result.metadata.specialistOffer?.consentRequired, true);
  assert.equal(result.handover, undefined);
  assert.match(result.response, /specialist/i);
  assert.doesNotMatch(result.response, /Priority|qualification|score|REFAL LEAD SUMMARY/i);
  assert.equal(user.history[0].metadata.handover, undefined);
  assert.ok(user.workflowCalls.some(([kind]) => kind === "qualification"));
  assert.ok(user.workflowCalls.some(([kind]) => kind === "intents"));
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
  assert.ok(user.workflowCalls.some(([kind]) => kind === "priority"));
});

test("the word team in earlier assistant text and generic تمام never create a handover", async () => {
  const user = { id: "ack-is-not-consent", profile: {}, history: [{ message: "Question", response: "The team can help if needed." }] };
  const result = await routeMessageResult({ userId: user.id, text: "تمام", store: integrationStore(user) });
  assert.equal(result.metadata.handover, undefined);
  assert.equal(result.metadata.specialistFollowUp, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
});

test("an explicit optional AI offer is tracked for the next turn and only then accepts consent", async () => {
  const user = { id: "tracked-offer-consent", profile: {}, history: [] };
  const store = integrationStore(user);
  await recordHistory(store, user.id, "I want to form a company", "Would you like me to connect you with a specialist?", {
    metadata: { intent: { primary: "company_formation", intents: ["company_formation"], language: "english" } }
  });
  assert.equal(user.history.at(-1).metadata.specialistOffer?.consentRequired, true);
  const consent = await routeMessageResult({ userId: user.id, text: "yes", store, existingUser: user });
  assert.equal(consent.metadata.specialistFollowUp.consented, true);
  assert.ok(user.workflowCalls.some(([kind]) => kind === "handover"));
});

test("a complete direct contact request is handled without asking permission again", async () => {
  for (const text of [
    "Please have a specialist contact me about this company setup",
    "I request a specialist to contact me and agree to share this inquiry with REFALCO",
    "Yes, I request a specialist contact me and agree to share this inquiry with REFALCO"
  ]) {
    const user = { id: `direct-contact-consent-${Math.random()}`, profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(result.metadata.specialistFollowUp.consented, true, text);
    assert.equal(result.metadata.specialistFollowUp.purpose, "specialist_follow_up", text);
    assert.ok(user.workflowCalls.some(([kind]) => kind === "handover"), text);
    assert.match(result.response, /recorded your request/i, text);
    assert.equal(user.workflowCalls.some(([kind]) => kind === "consent"), true, text);
  }
});

test("direct contact requests in Arabic and Greek scripts create the purpose-bound handover", async () => {
  for (const [text, language] of [
    ["نعم، خلي مختص يتواصل معي بخصوص مشروع الأرض", "arabic"],
    ["تواصلوا معي", "arabic"],
    ["Ναι, παρακαλώ ζητήστε από ειδικό να επικοινωνήσει για το έργο", "greek"]
  ]) {
    const user = { id: `localized-direct-${Math.random()}`, profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(result.metadata.specialistFollowUp?.consented, true, text);
    assert.equal(result.metadata.specialistFollowUp?.purpose, "specialist_follow_up", text);
    assert.equal(result.metadata.intent.language, language, text);
    assert.ok(user.workflowCalls.some(([kind]) => kind === "handover"), text);
  }
});

test("explicit denials persist as non-granted consent states", async () => {
  for (const [text, state] of [["Do not follow up", "revoked"], ["لا بدي متابعة", "denied"], ["Μην επικοινωνήσετε μαζί μου", "revoked"]]) {
    const user = { id: `deny-${Math.random()}`, profile: {}, history: [] };
    const store = integrationStore(user);
    const result = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
    await recordHistory(store, user.id, text, result.response, { metadata: result.metadata });
    assert.ok(user.workflowCalls.some(([kind, _id, saved]) => kind === "consent" && saved === state), `${text} should persist ${state}`);
  }
});

test("a persisted denial blocks a bare yes to an older offer but a new direct request is explicit consent", async () => {
  const deniedAt = new Date().toISOString();
  const oldOfferAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const user = {
    id: "persisted-denial-old-offer",
    profile: {},
    consent: { followUp: "revoked", followUpUpdatedAt: deniedAt },
    history: [{
      id: "old-offer",
      at: oldOfferAt,
      message: "I am exploring a development project.",
      response: "Would you like a specialist to contact you?",
      metadata: { intent: { intents: ["land_development"], language: "english" }, specialistOffer: { consentRequired: true, offeredAt: oldOfferAt } }
    }]
  };
  const store = integrationStore(user);
  const staleYes = await routeMessageResult({ userId: user.id, text: "yes", store, existingUser: user });
  assert.equal(staleYes.metadata.specialistFollowUp, undefined);
  assert.equal(staleYes.handover, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);

  const directRequest = await routeMessageResult({
    userId: user.id,
    text: "Please have a specialist contact me about this project.",
    store,
    existingUser: user
  });
  assert.equal(directRequest.metadata.specialistFollowUp?.consented, true);
  assert.ok(directRequest.handover);
  assert.ok(user.workflowCalls.some(([kind]) => kind === "handover"));
});

test("Arabic no-contact phrases and information-only corrections override direct-contact matching", async () => {
  const cases = [
    { text: "بدي معلومات عامة بس، لا تتواصلوا معي.", state: "revoked" },
    { text: "خلص، لا تتواصلوا معي ولا تبعتوا متابعة.", state: "revoked" },
    { text: "ما بدي حدا يتواصل معي.", state: "denied" },
    { text: "Please do not pressure me to book or send my contact details. I can ask for that later if I want.", state: "denied" },
    { text: "لما قلت إي، قصدي إي للمعلومة، مو موافقة حدا يتواصل معي.", state: "denied" }
  ];
  for (const [index, scenario] of cases.entries()) {
    const user = {
      id: `arabic-contact-denial-${index}`,
      profile: {},
      history: [{
        id: "tracked-offer-turn",
        message: "سؤال عن تطوير الأراضي",
        response: "Would you like a specialist to contact you?",
        metadata: { specialistOffer: { consentRequired: true } }
      }]
    };
    const store = integrationStore(user);
    const result = await routeMessageResult({ userId: user.id, text: scenario.text, store, existingUser: user });
    await recordHistory(store, user.id, scenario.text, result.response, { metadata: result.metadata });

    assert.equal(result.metadata.specialistFollowUp, undefined, scenario.text);
    assert.equal(result.metadata.handover, undefined, scenario.text);
    assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false, scenario.text);
    assert.ok(user.workflowCalls.some(([kind, _id, state]) => kind === "consent" && state === scenario.state), scenario.text);
    assert.equal(getConsentState({ user }), scenario.state, scenario.text);
    assert.equal(hasFollowUpPermission(user), false, scenario.text);
  }
});

test("no-contact-only messages receive a localized acknowledgment without a handover", async () => {
  const cases = [
    ["بدي معلومات عامة بس، لا تتواصلوا معي.", /رح خلي الحديث للمعلومات هون/],
    ["خلص، لا تتواصلوا معي ولا تبعتوا متابعة.", /ما رح أطلب من الفريق يتواصل معك/],
    ["Do not contact me.", /won’t request specialist follow-up/],
    ["Please do not pressure me to book or send my contact details. I can ask for that later if I want.", /won’t request specialist follow-up/],
    ["Μην επικοινωνήσετε μαζί μου.", /δεν θα ζητήσω επικοινωνία/]
  ];
  for (const [text, expected] of cases) {
    const user = { id: `no-contact-ack-${Math.random()}`, profile: {}, history: [] };
    const store = integrationStore(user);
    const result = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
    assert.match(result.response, expected, text);
    assert.equal(result.shouldUseAi, false, text);
    assert.equal(result.metadata.handover, undefined, text);
    assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false, text);
  }
});

test("no-pressure preference persists across an information question and suppresses proactive contact offers", async () => {
  const user = { id: "no-sales-pressure-persisted", profile: {}, history: [] };
  const store = integrationStore(user);
  const boundary = "Please do not pressure me to book or send my contact details. I can ask for that later if I want.";
  const first = await routeMessageResult({ userId: user.id, text: boundary, store, existingUser: user });
  await recordHistory(store, user.id, boundary, first.response, { metadata: first.metadata });
  assert.equal(user.profile.conversationPreferences.noProactiveBookingOrContact, true);

  const info = await routeMessageResult({ userId: user.id, text: "What services are included in company setup?", store, existingUser: user });
  assert.doesNotMatch(info.response, /book a call|specialist to follow up|when would you like to move forward/i);
  assert.equal(info.metadata.specialistOffer, undefined);
  assert.equal(info.metadata.specialistFollowUp, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
});

test("an information-only correction cannot revive a prior specialist offer", async () => {
  const user = {
    id: "arabic-info-only-not-contact",
    profile: {},
    history: [
      { id: "offer-turn", message: "Project question", response: "Would you like a specialist to follow up?", metadata: { specialistOffer: { consentRequired: true } } },
      { id: "yes-turn", message: "إي", response: "I can help with that.", metadata: { specialistFollowUp: { consented: true, purpose: "specialist_follow_up", trackedOffer: true } } }
    ]
  };
  const store = integrationStore(user);
  const result = await routeMessageResult({
    userId: user.id,
    text: "لما قلت إي قبل، قصدي إي للمعلومة، مو موافقة حدا يتواصل معي.",
    store,
    existingUser: user
  });
  await recordHistory(store, user.id, "لما قلت إي قبل، قصدي إي للمعلومة، مو موافقة حدا يتواصل معي.", result.response, { metadata: result.metadata });
  assert.equal(result.metadata.specialistFollowUp, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
  assert.ok(user.workflowCalls.some(([kind, _id, state]) => kind === "consent" && state === "denied"));
  assert.equal(getConsentState({ user }), "denied");
  assert.equal(hasFollowUpPermission(user), false);
});

test("explicit no-contact language revokes consent and prevents a tracked yes flow", async () => {
  const user = { id: "revoke-consent", profile: {}, history: [{ message: "Question", response: "Would you like a specialist to contact you?", metadata: { specialistOffer: { consentRequired: true } } }] };
  const result = await routeMessageResult({ userId: user.id, text: "Do not contact me", store: integrationStore(user) });
  await recordHistory(integrationStore(user), user.id, "Do not contact me", result.response, { metadata: result.metadata });
  assert.equal(result.metadata.specialistFollowUp, undefined);
  assert.ok(user.workflowCalls.some(([kind, _userId, state]) => kind === "consent" && state === "revoked"));
});

test("routeMessageResult handles a regulated Greek request locally and never falls through to AI", async () => {
  const user = { id: "35799123456@s.whatsapp.net", phone: "35799123456", profile: {}, history: [] };
  const result = await routeMessageResult({ userId: user.id, text: "Μπορεί η τράπεζα να εγκρίνει σίγουρα το δάνειο;", store: integrationStore(user) });
  assert.equal(result.shouldUseAi, false);
  assert.match(result.response, /Δεν μπορώ|Refalco/i);
  assert.doesNotMatch(result.response, /I can’t|I cannot|Before we continue/i);
  assert.ok(result.metadata.safety.risks.includes("banking"));
});

test("complaints and existing-client cases preserve internal escalation without creating a customer handover", async () => {
  for (const text of ["I want to make a complaint about the delay", "I am an existing client and need my contract"]) {
    const user = { id: "35799123456@s.whatsapp.net", phone: "35799123456", profile: {}, history: [] };
    const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user) });
    assert.equal(result.shouldUseAi, false);
    assert.equal(result.handover, undefined);
    assert.equal(result.metadata.handover, undefined);
    assert.doesNotMatch(result.response, /Severity|Customer:|REFAL LEAD SUMMARY|score/i);
    assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
    if (/complaint/i.test(text)) {
      assert.ok(user.workflowCalls.some(([kind]) => kind === "complaint"));
      assert.ok(user.workflowCalls.some(([kind]) => kind === "priority"));
    } else {
      assert.ok(user.workflowCalls.some(([kind]) => kind === "existing_client"));
      assert.ok(user.workflowCalls.some(([kind]) => kind === "priority"));
    }
  }
});

test("restricted high-priority requests create an internal alert but no customer handover", async () => {
  const user = { id: "restricted-no-consent", profile: {}, history: [] };
  const result = await routeMessageResult({
    userId: user.id,
    text: "Will my planning permit be approved?",
    store: integrationStore(user)
  });
  assert.equal(result.metadata.safety.restricted, true);
  assert.equal(result.metadata.handover, undefined);
  assert.equal(result.handover, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
  assert.ok(user.workflowCalls.some(([kind, _id, alert]) => kind === "priority" && alert.trigger === "sensitive_or_complex"));
});

test("persisted follow-up denial prevents a new optional specialist offer", async () => {
  for (const state of ["denied", "revoked"]) {
    const user = {
      id: `persisted-${state}`,
      profile: {},
      consent: { followUp: state, followUpUpdatedAt: new Date().toISOString() },
      history: []
    };
    const result = await routeMessageResult({
      userId: user.id,
      text: "We need a large land development and a strategic partnership",
      store: integrationStore(user)
    });
    await recordHistory(integrationStore(user), user.id, "We need a large land development and a strategic partnership", result.response, { metadata: result.metadata });
    assert.equal(result.metadata.specialistOffer, undefined, state);
    assert.equal(result.metadata.handover, undefined, state);
    assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false, state);
    assert.doesNotMatch(result.response, /specialist|follow up/i, state);
    assert.ok(user.workflowCalls.some(([kind]) => kind === "priority"), state);
  }
});

test("a pending existing-client verification does not block an unrelated service question or refusal to share details", async () => {
  const user = {
    id: "verification-context-test",
    profile: { existingClientState: { state: "awaiting_identifier", attempts: 0 } },
    history: [{ message: "Existing client support", response: "Please provide the approved account identifier.", metadata: { existingClientVerification: { state: "awaiting_identifier" } } }]
  };
  const store = integrationStore(user);
  const text = "I'm not giving account details. Just answer which services are listed.";
  const result = await routeMessageResult({ userId: user.id, text, store, existingUser: user });
  assert.equal(result.shouldUseAi, true);
  assert.equal(result.metadata.existingClientVerification, undefined);
  assert.equal(result.handover, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "existing_client"), false);

  const correctedQuestion = "Are you describing an available service, or promising a specific result for my case?";
  const clarification = await routeMessageResult({ userId: user.id, text: correctedQuestion, store, existingUser: user });
  assert.doesNotMatch(clarification.response, /approved identifier|verification detail/i);
  assert.equal(clarification.metadata.existingClientVerification, undefined);
});

test("an existing client asking for a safe written profile-update route gets Arabic guidance without account verification", async () => {
  const user = {
    id: "existing-client-safe-channel-ar",
    profile: { existingClientState: { state: "awaiting_identifier", attempts: 0 } },
    history: [{ message: "رقم الملف TEST-48291، فرجيني الملاحظات لو سمحت.", response: "ما فيني أعرض بيانات الملف قبل التحقق.", metadata: { existingClientVerification: { state: "awaiting_identifier" }, intent: { language: "arabic" } } }]
  };
  const text = "طيب، شكراً عالتنبيه. بس شو القناة الآمنة يلي بتنصحني فيها لتحديث ملفي؟";
  const result = await routeMessageResult({ userId: user.id, text, store: integrationStore(user), existingUser: user });
  assert.match(result.response, /ما عندي معلومة مؤكدة عن قناة آمنة محددة/);
  assert.match(result.response, /وسيلة التواصل الرسمية المنشورة لدى ريفالكو/);
  assert.doesNotMatch(result.response, /رقم الملف|رقم التحقق|أرسل.*(?:رقم|بيانات)|تواصل معي|سأتواصل/);
  assert.equal(result.metadata.existingClientVerification, undefined);
  assert.equal(result.handover, undefined);
  assert.equal(user.workflowCalls.some(([kind]) => kind === "handover"), false);
  assert.equal(user.profile.existingClientState.state, "awaiting_identifier");
});
