const { detectMessageLanguage, detectExplicitLanguageRequest } = require("./language");
const { restrictedRefalcoReply } = require("./refalcoAnswer");
const { detectIntent, INTENTS } = require("./intent");
const { classifySafety, safeLocalizedFallback } = require("./safetyPolicy");
const { qualifyLead, consentFromText, getConsentState } = require("./leadQualification");
const { assessPriority } = require("./priorityRules");
const { handleComplaint } = require("./complaintWorkflow");
const {
  beginExistingClientFlow,
  transitionExistingClientState,
  existingClientCustomerMessage,
  EVENTS
} = require("./existingClientWorkflow");
const { createHandover } = require("./handover");
const { detectObjection, objectionResponse } = require("./objectionWorkflow");
const { safeFallbackData, validateResponse } = require("./responsePolicy");
const { createCorrectionEvent } = require("./correctionWorkflow");
const { updateIntake, intakeTypesForIntents, typeForIntents } = require("./opportunityIntake");
const { assessRedFlags } = require("./redFlagRules");
const { extractSafeRequestFromPrivacyMessage } = require("./privacyIntent");

const NO_PROACTIVE_CONTACT_OR_BOOKING = /\b(?:please\s+)?do\s+not\s+pressure\s+me\s+(?:to\s+book|about\s+(?:a\s+)?call|to\s+send|to\s+share)\b.{0,100}\b(?:contact\s+details|contact|booking|book|share|send)\b|\b(?:please\s+)?don't\s+pressure\s+me\s+(?:to\s+book|about\s+(?:a\s+)?call|to\s+send|to\s+share)\b.{0,100}\b(?:contact\s+details|contact|booking|book|share|send)\b|\b(?:i|we)\s+(?:can|will|'ll)\s+(?:ask|reach\s+out|come\s+back|contact)\b.{0,100}\b(?:later|when\s+(?:i|we)(?:'m|\s+am|\s+are)\s+ready|if\s+(?:i|we)\s+decide)\b|\b(?:still\s+comparing|not\s+ready\s+to\s+(?:book|schedule|share\s+(?:my\s+)?contact))\b.{0,100}\b(?:later|when\s+(?:i|we)(?:'m|\s+am|\s+are)\s+ready|if\s+(?:i|we)\s+decide)\b|\bden\s+thelo\s+na\s+me\s+piesis\b.{0,140}\b(?:kleiso|stoicheia\s+epikoinonias|epikoinonias)\b|\b(?:an|otan)\s+(?:thelo|xreiastei|apofasiso)\b.{0,100}\b(?:tha\s+)?(?:rotiso|epikoinoniso|to\s+zit(?:iso|iseis))\b|إذا\s*(?:قررت|احتجت|بحتاج).{0,100}(?:بسأل|رح\s*اسأل|بتواصل|بحكي).{0,50}(?:بعدين|لاحقاً|لما\s*كون\s*جاهز)|(?:لسا\s*عم\s*قارن|مو\s*جاهز).{0,100}(?:بعدين|لاحقاً|لما\s*قرر)|\b(?:αν|όταν)\s+(?:αποφασίσω|είμαι\s+έτοιμος|το\s+χρειαστώ)\b.{0,100}\b(?:θα\s+)?(?:ρωτήσω|επικοινωνήσω|κλείσω)\b.{0,40}\b(?:αργότερα|μετά)\b/iu;
const GREEKLISH_CLOSURE = /^(?=.*\bden\s+(?:exo|eho)\s+kati\s+allo\b)(?=.*\b(?:xreiaso|xreiazomai)\s+kati\b)(?=.*\btha\s+to\s+zit(?:iso|so)\b).{1,260}$/iu;

const HELP = [
  "RAFA replies inside WhatsApp from the linked business number.",
  "Commands:",
  "profile - show your saved details",
  "reset - clear your saved details",
  "Ask a Refalco question or request a meeting."
].join("\n");

function hasVerifiedHandoverClaim(metadata = {}) {
  const purposeBoundConsent = metadata.specialistFollowUp?.consented === true && metadata.specialistFollowUp?.purpose === "specialist_follow_up";
  const persistedHandover = Boolean(metadata.handover?.routing && metadata.handover?.summary) || metadata.handoverAlreadyRecorded === true;
  return purposeBoundConsent && persistedHandover;
}

async function recordHistory(store, userId, message, response, extra) {
  const metadata = { ...(extra?.metadata || {}) };
  delete metadata.privacySafeQuestion;
  if (!metadata.specialistOffer && isTrackedSpecialistOffer(response)) {
    metadata.specialistOffer = { offered: true, consentRequired: true, offeredAt: new Date().toISOString() };
  }
  const language = metadata?.intent?.language === "arabic" ? "ar" : metadata?.intent?.language === "greek" ? "el" : "en";
  const consentGranted = metadata.specialistFollowUp?.consented === true && metadata.specialistFollowUp?.purpose === "specialist_follow_up";
  const responsePolicy = validateResponse(response, { minSentences: 0, maxSentences: 8, maxQuestions: 1, maxChars: 1000, allowVerifiedHandoverClaim: hasVerifiedHandoverClaim(metadata) });
  const safeResponse = responsePolicy.valid ? response : safeFallbackData({ language, category: "uncertainty" }).text;
  const privacyTurn = metadata.safety?.risks?.includes("privacy");
  const storedMessage = privacyTurn ? "[message omitted: potentially sensitive credentials]" : message;
  const consentDecision = consentFromText(message);
  const explicitOptOut = consentDecision === "revoked";
  const handover = consentGranted ? metadata.handover : null;
  // Do not persist an unconsented handover even as turn metadata.
  if (!consentGranted) delete metadata.handover;
  const turn = await store.addHistory(userId, storedMessage, safeResponse, {
    automated: true,
    source: "whatsapp",
    responsePolicy,
    ...(extra || {}),
    metadata
  });
  // The turn ID is required as a foreign key for the workflow records above.
  // Once it exists, these persistence operations are independent; serial awaits
  // added one full Edge Function round-trip per record to every eligible turn.
  const writes = [];
  let handoverWrite = null;
  const qualification = metadata.qualification;
  if (!privacyTurn && qualification && typeof store.saveQualification === "function") {
    writes.push(store.saveQualification(userId, qualification.dimensions || {}, {
      thresholds: qualification.thresholds,
      priority: metadata.priority?.level && metadata.priority.level !== "normal",
      priorityReason: metadata.priority?.triggers?.[0],
      sourceTurnId: turn?.id
    }));
  }
  if (!privacyTurn && metadata.intent?.intents?.length && typeof store.saveIntents === "function") {
    writes.push(store.saveIntents(userId, metadata.intent.intents, { sourceTurnId: turn?.id, source: "deterministic" }));
  }
  if ((explicitOptOut || consentDecision === "denied" || consentGranted) && typeof store.saveConsent === "function") {
    writes.push(store.saveConsent(userId, explicitOptOut ? "revoked" : consentDecision === "denied" ? "denied" : "granted", { sourceTurnId: turn?.id }));
  }
  if (handover && typeof store.createHandover === "function") {
    handoverWrite = store.createHandover(userId, {
      department: handover.routing?.department || "general",
      priority: handover.routing?.priority || "normal",
      summary: handover.summary || {},
      sourceTurnId: turn?.id
    });
    writes.push(handoverWrite);
  }
  if (!privacyTurn && metadata.priority?.triggers?.length && typeof store.createPriorityAlert === "function") {
    const validTriggers = new Set(["major_development", "institutional_investment", "strategic_partnership", "complaint", "severe_complaint", "existing_client", "safety_or_threat", "material_business_opportunity", "sensitive_or_complex"]);
    for (const trigger of metadata.priority.triggers.filter((value) => validTriggers.has(value))) {
      writes.push(store.createPriorityAlert(userId, {
        level: metadata.priority.level === "urgent" ? "urgent" : "high",
        trigger,
        details: { source: "deterministic", intent: metadata.intent?.primary || "unknown" },
        sourceTurnId: turn?.id
      }));
    }
  }
  if (metadata.complaint && typeof store.createComplaint === "function") {
    writes.push(store.createComplaint(userId, {
      severity: metadata.complaint.severity === "urgent" ? "urgent" : "high",
      summary: metadata.complaint.summary || String(message || "").slice(0, 2000),
      sourceTurnId: turn?.id
    }));
  }
  if (metadata.existingClientVerification && typeof store.saveExistingClientVerification === "function") {
    const state = metadata.existingClientVerification;
    writes.push(store.saveExistingClientVerification(userId, {
      state: state.state,
      attempts: state.attempts,
      identifierProvided: Boolean(state.identifierProvided)
    }));
  }
  if (metadata.opportunityIntakes && typeof store.saveOpportunityIntake === "function") {
    writes.push(...Object.values(metadata.opportunityIntakes).map((intake) => store.saveOpportunityIntake(userId, intake, { sourceTurnId: turn?.id })));
  } else if (metadata.opportunityIntake && typeof store.saveOpportunityIntake === "function") {
    writes.push(store.saveOpportunityIntake(userId, metadata.opportunityIntake, { sourceTurnId: turn?.id }));
  }
  if (metadata.correction && typeof store.logAuditEvent === "function") {
    writes.push(store.logAuditEvent(userId, "customer_correction", { ...metadata.correction, sourceTurnId: turn?.id }, "customer"));
  }
  if (!privacyTurn && metadata.redFlags?.flags?.length && typeof store.logAuditEvent === "function") {
    writes.push(store.logAuditEvent(userId, "red_flags_detected", metadata.redFlags, "system"));
  }
  await Promise.all(writes);
  if (handoverWrite) {
    const saved = await handoverWrite;
    if (saved?.id && typeof store.updateUser === "function") {
      await store.updateUser(userId, (draft) => {
        draft.profile = { ...(draft.profile || {}), handover: { ...metadata.handover, id: saved.id, required: true, status: "open" } };
      });
    }
    if (saved?.id && typeof store.createNotification === "function") {
      try {
        const summary = handover.summary || {};
        const dashboardUrl = String(process.env.DASHBOARD_PUBLIC_URL || process.env.DASHBOARD_URL || "").trim();
        let conversationUrl = "";
        try {
          const parsed = new URL(dashboardUrl);
          if (["http:", "https:"].includes(parsed.protocol)) {
            parsed.searchParams.set("section", "conversations");
            parsed.searchParams.set("view", "inbox");
            parsed.searchParams.set("conversation", userId);
            conversationUrl = parsed.href;
          }
        } catch { /* Admin mail will direct staff to the dashboard queue. */ }
        await store.createNotification({
          kind: "handover_review",
          handoverId: saved.id,
          idempotencyKey: `handover:${saved.id}:admin-review-email`,
          payload: {
            dashboardUrl: conversationUrl,
            department: handover.routing?.department || "general",
            priority: handover.routing?.priority || "normal",
            intent: summary.intent || "",
            name: isPlausibleCustomerName(summary.customer?.name) ? summary.customer.name : "",
            need: summary.need || summary.opportunity || ""
          }
        });
      } catch {
        // The durable handover remains in the admin inbox; the notification worker reports delivery issues.
        if (typeof store.logEvent === "function") await store.logEvent("handover_notification_queue_error", { handoverId: saved.id, code: "queue_failed" }).catch(() => {});
      }
    }
  }
  return { turn, turnId: turn?.id || null };
}

function isTrackedSpecialistOffer(response) {
  const text = String(response || "");
  const hasExplicitOffer = /(?:would you like|shall i|may i|if you want|with your permission).{0,140}(?:specialist|team|follow.?up|contact|connect)|(?:specialist|team|follow.?up|contact|connect).{0,140}(?:would you like|shall i|may i|with your permission)|(?:إذا بتحب|إذا بتحبي|هل ترغب|هل تود|إذا أردت).{0,130}(?:مختص|الفريق|يتواصل|يتابع)|(?:مختص|الفريق).{0,130}(?:إذا بتحب|إذا بتحبي|هل ترغب|هل تود)|(?:αν θέλετε|θα θέλατε|με την άδειά σας).{0,130}(?:ειδικ|ομάδα|επικοινων)|(?:ειδικ|ομάδα).{0,130}(?:αν θέλετε|θα θέλατε|με την άδειά σας)/iu.test(text);
  return hasExplicitOffer && /[?؟;]/u.test(text) ? true : false;
}

function isFreshSpecialistOffer(turn) {
  if (turn?.metadata?.specialistOffer?.consentRequired !== true) return false;
  const offeredAt = Date.parse(turn.metadata.specialistOffer.offeredAt || turn.at || "");
  return Number.isFinite(offeredAt) && Date.now() - offeredAt <= 24 * 60 * 60 * 1000 && offeredAt <= Date.now() + 5 * 60 * 1000;
}

function localized(language, messages) {
  return messages[language] || messages.english;
}

function findReferencedSpecialistOffer(history = [], incoming = "") {
  const refersToEarlierOffer = /\b(?:i\s+meant\s+yes\s+to|i\s+mean\s+yes\s+to|i\s+was\s+referring\s+to)\s+(?:your\s+)?(?:last|earlier|previous)\s+(?:question|offer)\b|(?:^|[^\p{L}])(?:قصدي|كنت أقصد|كنت اقصد)\s+(?:نعم|إي|اي|موافق)\s+(?:على\s+)?(?:سؤالك|السؤال|عرضك)\s*(?:اللي\s+قبل|السابق|الأخير|الاخير)?|(?:^|\s)(?:εννοούσα|εννοώ)\s+ναι\s+(?:στην|στο)\s+(?:προηγούμενη|τελευταία)\s+(?:ερώτηση|προσφορά)/iu.test(incoming);
  if (!refersToEarlierOffer || !Array.isArray(history)) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const offerTurn = history[index];
    if (offerTurn?.metadata?.specialistOffer?.consentRequired !== true) continue;
    const offeredAt = Date.parse(offerTurn.metadata.specialistOffer.offeredAt || offerTurn.at || "");
    if (!Number.isFinite(offeredAt) || Date.now() - offeredAt > 24 * 60 * 60 * 1000 || offeredAt > Date.now() + 5 * 60 * 1000) return null;
    const interveningCustomerTurns = history.slice(index + 1).map((turn) => String(turn?.message || "").trim()).filter(Boolean);
    const acknowledgementsOnly = interveningCustomerTurns.every((message) => /^(?:thanks?|thank you|thx|okay|ok|got it|تمام(?:[،, ]+(?:شكرًا|شكرا))?|شكرا|شكرًا|يسلمو|ευχαριστώ|εντάξει)[.!،,؟?\s]*$/iu.test(normalizeSmallTalk(message)));
    if (!acknowledgementsOnly || interveningCustomerTurns.some((message) => consentFromText(message) === "denied" || consentFromText(message) === "revoked")) return null;
    return offerTurn;
  }
  return null;
}

function helpText(language) {
  if (language === "arabic") return [
    "يرد رفا عبر واتساب من رقم الشركة المرتبط.", "الأوامر:",
    "profile - عرض بياناتك المحفوظة", "reset - حذف بياناتك المحفوظة",
    "يمكنك طرح سؤال عن ريفالكو أو طلب اجتماع."
  ].join("\n");
  if (language === "greek") return [
    "Η RAFA απαντά στο WhatsApp από τον συνδεδεμένο εταιρικό αριθμό.", "Εντολές:",
    "profile - εμφάνιση των αποθηκευμένων στοιχείων σας", "reset - διαγραφή των αποθηκευμένων στοιχείων σας",
    "Ρωτήστε για τη Refalco ή ζητήστε μια συνάντηση."
  ].join("\n");
  return HELP;
}

function hasLimitedHandoverScope(text) {
  return /\b(?:share|send|forward|include)\b.{0,80}\b(?:only|just)\b.{0,45}\b(?:project|inquiry|conversation|chat|summary)\b|\b(?:only|just)\s+(?:the\s+)?(?:project|inquiry)\s+summary\b|\bnot\s+(?:the\s+)?rest\s+of\s+(?:the\s+)?(?:conversation|chat)\b|شاركوا?.{0,70}(?:ملخص|الملخص).{0,20}(?:بس|فقط)|(?:ملخص|الملخص).{0,30}(?:بس|فقط).{0,80}(?:مو|مش|ليس).{0,30}(?:باقي|بقية).{0,30}(?:المحادثة|الحكي)|(?:μοιραστείτε|στείλτε|κοινοποιήστε).{0,70}(?:μόνο|σύνοψη).{0,60}(?:έργου|ερωτήματος|συνομιλίας)|μόνο\s+(?:τη\s+)?σύνοψη\s+(?:του\s+)?(?:έργου|ερωτήματος)|όχι\s+(?:το\s+)?υπόλοιπο\s+της\s+συνομιλίας/iu.test(String(text || ""));
}

function handoverFor({ user, userId, incoming, inquiry, inquiryMetadata = {}, classification, language, response }) {
  const sensitiveSource = ["privacy", "prompt_injection"].some((risk) => inquiryMetadata.safety?.risks?.includes(risk));
  const inquirySummary = sensitiveSource ? "[current inquiry omitted for privacy]" : String(inquiry || incoming || "").trim().slice(0, 500);
  // Consent authorizes a narrowly scoped follow-up for this inquiry. Never
  // attach stored profile fields, qualification, intake objects, or transcript.
  const normalizedIntent = classification.intents.find((intent) => ![INTENTS.UNKNOWN, INTENTS.GREETING, INTENTS.SMALL_TALK, INTENTS.AGENT_IDENTITY].includes(intent));
  const intents = normalizedIntent ? [normalizedIntent === INTENTS.LAND_DEVELOPMENT ? "development" : normalizedIntent] : [];
  return createHandover({
    input: inquirySummary,
    customer: { name: isPlausibleCustomerName(user.profile?.name) ? user.profile.name : undefined, whatsappContact: userId },
    conversation: { lastMessage: inquirySummary },
    need: inquirySummary,
    intents,
    language,
    sharingScope: "current_inquiry_only",
    customerMessage: response
  });
}

async function prepareInboundMessage({ userId, incoming, user, store }) {
  const safety = classifySafety(incoming);
  const privacyRisk = safety.risks.includes("privacy");
  const safePrivacyQuestion = privacyRisk && safety.risks.every((risk) => risk === "privacy")
    ? extractSafeRequestFromPrivacyMessage(incoming)
    : "";
  const privacyContinuation = safePrivacyQuestion.length >= 8;
  const routingText = privacyContinuation ? safePrivacyQuestion : incoming;
  const classification = detectIntent(routingText);
  const priority = assessPriority({ text: routingText, intents: classification.intents });
  const redFlags = assessRedFlags(routingText, { profile: user.profile || {} });
  const history = [...(user.history || []), { message: incoming }];
  const lastTurn = user.history?.[user.history.length - 1];
  const askedForName = wasNameRequested(lastTurn);
  const capturedName = privacyRisk ? null : extractCustomerName(incoming) || (askedForName ? extractBareCustomerName(incoming) : null);
  if (user.profile?.name && !isPlausibleCustomerName(user.profile.name) && typeof store.updateUser === "function") {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}) };
      delete draft.profile.name;
      delete draft.profile.nameSource;
      delete draft.profile.nameUpdatedAt;
    });
    delete user.profile.name;
    delete user.profile.nameSource;
    delete user.profile.nameUpdatedAt;
  }
  if (capturedName && capturedName !== user.profile?.name && typeof store.updateUser === "function") {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}), name: capturedName, nameSource: "customer_stated", nameUpdatedAt: new Date().toISOString() };
    });
    user.profile = { ...(user.profile || {}), name: capturedName, nameSource: "customer_stated" };
  }
  const qualification = qualifyLead({ history, profile: user.profile || {}, booking: user.booking });
  const correction = privacyRisk ? null : createCorrectionEvent({ userId, text: incoming });
  if (correction?.field && correction.correctedValue && typeof store.updateUser === "function") {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}), [correction.field]: correction.correctedValue };
      draft.profile.correctionUpdatedAt = correction.timestamp;
    });
  }
  const existingIntakes = user.profile?.opportunityIntakes || {};
  // One message may carry several related intents (e.g. “investment company”).
  // Keep the formation intake as the primary record; secondary intents remain
  // in the intent classification rather than creating duplicate intake rows.
  const continuation = privacyRisk ? null : pendingIntakeAnswer({ user, lastTurn, incoming, classification, existingIntakes });
  const primaryIntakeType = privacyRisk || continuation ? null : typeForIntents(classification.intents);
  const opportunityIntakes = primaryIntakeType
    ? { [primaryIntakeType]: updateIntake(existingIntakes[primaryIntakeType] || null, { intents: [primaryIntakeType], text: incoming }) }
    : {};
  if (continuation) {
    const prior = existingIntakes[continuation.type] || user.profile?.opportunityIntake;
    const next = updateIntake(prior, { intents: [continuation.type], text: "" });
    next.data.businessActivity = incoming.trim().replace(/[.!؟?]+$/u, "").slice(0, 180);
    next.provenance.businessActivity = "customer_stated";
    next.missingFields = next.missingFields.filter((field) => field !== "businessActivity");
    opportunityIntakes[continuation.type] = next;
  }
  // An intake advances on a new matching intent, or on a direct answer to the
  // immediately preceding, field-specific assistant question. It never replays
  // from an old profile alone.
  const opportunityIntake = Object.values(opportunityIntakes)[0] || null;
  if (typeof store.updateUser === "function") {
    await store.updateUser(userId, (draft) => {
      draft.profile = draft.profile || {};
      if (!privacyRisk) draft.profile.leadQualification = { ...qualification, updatedAt: new Date().toISOString(), source: "message_router_v1" };
      if (opportunityIntake) draft.profile.opportunityIntake = opportunityIntake;
      if (Object.keys(opportunityIntakes).length) draft.profile.opportunityIntakes = { ...existingIntakes, ...opportunityIntakes };
    });
  }
  return {
    classification,
    safety,
    priority,
    qualification: { dimensions: qualification.dimensions, total: qualification.total, status: qualification.status, thresholds: qualification.thresholds },
    metadata: {
      intent: { primary: classification.primary, intents: classification.intents, isMultiIntent: classification.isMultiIntent, language: classification.language },
      safety: { restricted: safety.restricted, risks: safety.risks },
      ...(privacyContinuation ? { privacySafeQuestion: safePrivacyQuestion } : {}),
      priority: { level: priority.level, triggers: priority.triggers, handoverRequired: priority.handoverRequired },
      qualification: { dimensions: qualification.dimensions, total: qualification.total, status: qualification.status, thresholds: qualification.thresholds },
      redFlags
      , opportunityIntake, opportunityIntakes, correction,
      ...(capturedName ? { customerNameCaptured: true } : {})
    }
  };
}

const INTAKE_CONTINUATION_BLOCKED_INTENTS = new Set([
  INTENTS.PROMPT_INJECTION, INTENTS.COMPLAINT, INTENTS.EXISTING_CLIENT,
  INTENTS.LEGAL, INTENTS.TAX, INTENTS.IMMIGRATION, INTENTS.BANKING,
  INTENTS.PERMIT, INTENTS.APPROVAL, INTENTS.APPOINTMENT, INTENTS.CONTACT,
  INTENTS.AGENT_IDENTITY, INTENTS.PRICING, INTENTS.GREETING,
  INTENTS.SMALL_TALK
]);
const COMPANY_ACTIVITY_QUESTION = /(?:what\s+(?:will|would|does)\s+(?:the\s+)?company\s+(?:do|offer)|what(?:'s| is)\s+(?:the\s+)?(?:company'?s?\s+)?(?:purpose|business activity|activity)|what kind of business|what activity|شو\s+(?:رح\s+)?تعمل\s+(?:الشركة|شركتك)|شو\s+(?:نشاط|مجال|غرض)\s+(?:الشركة|شركتك)|ما\s+(?:هو\s+)?(?:نشاط|غرض)\s+(?:الشركة|الشركة؟)?|ما\s+النشاط\s+الذي|τι\s+δραστηριότητα\s+θα\s+έχει|με\s+τι\s+θα\s+ασχολείται\s+η\s+εταιρεία|ποιος\s+είναι\s+ο\s+σκοπός\s+της\s+εταιρείας)/iu;
const NON_ANSWER = /^(?:yes|yeah|yep|no|nope|ok(?:ay)?|تمام|اي|إي|نعم|لا|ما بعرف|ما بعرفش|ما بعرف لسه|لا أعرف|مش عارف|δεν ξέρω|ναι|όχι)[.!،؟?\s]*$/iu;

function pendingIntakeAnswer({ user, lastTurn, incoming, classification, existingIntakes }) {
  const response = String(lastTurn?.response || "");
  if (!COMPANY_ACTIVITY_QUESTION.test(response) || !incoming.trim() || incoming.length > 180 || /[?؟]/u.test(incoming) || NON_ANSWER.test(incoming.trim())) return null;
  if (classification.intents.some((intent) => INTAKE_CONTINUATION_BLOCKED_INTENTS.has(intent))) return null;
  const intake = existingIntakes?.company_formation || user.profile?.opportunityIntake;
  if (intake?.type !== "company_formation" || intake.status !== "in_progress") return null;
  const updatedAt = Date.parse(intake.updatedAt || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 72 * 60 * 60 * 1000 || updatedAt > Date.now() + 5 * 60 * 1000) return null;
  return { type: "company_formation", field: "businessActivity" };
}

function resultWithHistory({ response, user, metadata, handover, history }) {
  const language = metadata?.intent?.language === "arabic" ? "ar" : metadata?.intent?.language === "greek" ? "el" : "en";
  const policy = validateResponse(response, { minSentences: 0, maxSentences: 8, maxQuestions: 1, maxChars: 1000, allowVerifiedHandoverClaim: hasVerifiedHandoverClaim(metadata) });
  const safeResponse = policy.valid ? response : safeFallbackData({ language, category: "uncertainty" }).text;
  return { response: safeResponse, shouldUseAi: false, user, metadata: { ...metadata, responsePolicy: policy }, handover, ...history };
}

function existingClientReply(language, state) {
  if (language === "greek") {
    if (state.state === "authenticated") return "Η ταυτότητά σας επαληθεύτηκε. Μπορώ πλέον να βοηθήσω με πληροφορίες που αφορούν τον λογαριασμό σας.";
    if (state.state === "locked") return "Δεν ήταν δυνατή η επαλήθευση. Για την ασφάλειά σας, επικοινωνήστε με την ομάδα της Refalco μέσω εγκεκριμένου καναλιού.";
    return "Για την προστασία του απορρήτου σας, παρακαλώ δώστε το εγκεκριμένο αναγνωριστικό ή στοιχείο επαλήθευσης του λογαριασμού σας. Δεν μπορώ να αποκαλύψω στοιχεία πριν από την επαλήθευση.";
  }
  if (language === "arabic") {
    if (state.state === "authenticated") return "تم التحقق من هويتك. فيني ساعدك هلأ بمعلومات تخص حسابك.";
    if (state.state === "locked") return "ما قدرت أتحقق من البيانات بعد عدة محاولات. لحماية خصوصيتك، تواصل مع ريفالكو عبر وسيلة رسمية.";
    return "لحماية خصوصيتك، أرسل فقط رقم الملف أو معلومة التحقق المعتمدة. ما فيني أعرض تفاصيل الحساب قبل التحقق.";
  }
  return existingClientCustomerMessage(state);
}

function isSafeProfileUpdateChannelQuestion(text) {
  return /\b(?:safe|secure)\s+(?:channel|way|method)\b.{0,80}\b(?:update|updating|profile|account|case|file)\b|\bhow\s+(?:can|do)\s+i\s+(?:safely\s+)?(?:update|change)\s+(?:my\s+)?(?:profile|account|case)\b|(?:قناة|طريقة)\s*(?:ال)?(?:آمنة|موثوقة)\s*.{0,60}(?:تحديث|ملفي|حسابي|بياناتي)|(?:كيف|شو)\s*(?:فيني|بقدر)\s*(?:أحدّث|احدث|حدّث|أغيّر|اغير)\s*(?:ملفي|حسابي|بياناتي)\s*(?:بشكل\s*)?(?:آمن|آمنة)|(?:ασφαλ(?:ές|ή)\s+κανάλι|ασφαλή\s+τρόπο).{0,80}(?:ενημερ|προφίλ|λογαριασμ)|πώς\s+μπορώ\s+να\s+ενημερώσω\s+(?:με\s+ασφάλεια\s+)?(?:το\s+)?(?:προφίλ|λογαριασμό)/iu.test(String(text || ""));
}

function safeProfileUpdateChannelReply(language) {
  return localized(language, {
    english: "I can’t confirm a specific secure update channel from here. Use REFALCO’s official published contact route and ask for a written profile update; please don’t send sensitive details in this chat.",
    arabic: "ما عندي معلومة مؤكدة عن قناة آمنة محددة لتحديث ملفك. استخدم وسيلة التواصل الرسمية المنشورة لدى ريفالكو واطلب التحديث كتابةً، ولا تبعت بيانات حساسة هون.",
    greek: "Δεν μπορώ να επιβεβαιώσω συγκεκριμένο ασφαλές κανάλι ενημέρωσης από εδώ. Χρησιμοποιήστε τα επίσημα δημοσιευμένα στοιχεία επικοινωνίας της REFALCO και ζητήστε γραπτή ενημέρωση· μην στείλετε ευαίσθητα στοιχεία σε αυτή τη συνομιλία."
  });
}

function isValidWhatsAppReplyKey(userId, key) {
  if (!key || typeof key !== "object" || Array.isArray(key)) return false;
  const jid = String(userId || "");
  const id = String(key.id || "");
  return key.fromMe === true && key.remoteJid === jid &&
    /^(?:\d+|[A-Za-z0-9._-]+)@(?:s\.whatsapp\.net|c\.us|lid)$/.test(jid) &&
    /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

function buildReplyEditPayload({ userId, text, mode, messageKey } = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error("Invalid reply update text.");
  if (mode === "platform_edit") {
    if (!isValidWhatsAppReplyKey(userId, messageKey)) throw new Error("Original WhatsApp message key is invalid.");
    return { text: text.trim(), edit: messageKey };
  }
  if (mode === "correction_resend") return { text: `Correction: ${text.trim()}` };
  throw new Error("Invalid reply update mode.");
}

async function persistWhatsAppSentMessage({ store, userId, response, turn, sentMessage, sentAt = new Date().toISOString() }) {
  if (!turn?.id || !sentMessage?.key || typeof store.updateHistoryTurn !== "function") return turn || null;
  return store.updateHistoryTurn(userId, turn.id, {
    response,
    metadata: {
      whatsapp: {
        messageKey: sentMessage.key,
        sentAt
      }
    }
  });
}

function profileText(user) {
  const profile = user.profile || {};
  return [
    "Saved details:",
    `Name: ${isPlausibleCustomerName(profile.name) ? profile.name : "not set"}`,
    `Company/project: ${profile.company || "not set"}`,
    `Need: ${profile.needOverride || profile.need || "not set"}`
  ].join("\n");
}

function extractCustomerName(text) {
  const value = String(text || "").trim();
  const selfIntroduction = /^(?:my name is|i am|i'm|call me|(?:أنا|انا) اسمي|اسمي|أنا|انا|με λένε|με λενε|λέγομαι|λεγομαι|ονομάζομαι|ονομαζομαι|είμαι\s+(?:ο|η|το)|ειμαι\s+(?:ο|η|το))\s+(.+)$/iu;
  const match = value.match(selfIntroduction);
  if (!match) return null;
  const candidate = match[1]
    .split(/\s*(?:,|،|;|؛|\b(?:and|with|my phone|my number|same whatsapp|same number|whatsapp|phone|number)\b|(?:ورقمي|رقمي|نفس الواتساب|نفس الرقم|رقم هاتفي|واتسابي)|και|στο ίδιο|ίδιο whatsapp)\s*/iu)[0]
    .replace(/^(?:ο|η|το)\s+/iu, "")
    .replace(/[.!،؟?]+$/u, "")
    .trim();
  const genericGreekIdentityIntro = /^(?:είμαι\s+(?:ο|η|το)|ειμαι\s+(?:ο|η|το))\s+/iu.test(value);
  if (genericGreekIdentityIntro && /^(?:ιδιοκτήτης|ιδιοκτήτρια|υπεύθυνος|υπεύθυνη|πελάτης|πελάτισσα)(?:\s|$)/iu.test(candidate)) return null;
  if (!isPlausibleCustomerName(candidate)) return null;
  return candidate;
}

function isPlausibleCustomerName(value) {
  const name = String(value || "").trim();
  if (name.length < 2 || name.length > 60 || !/^\p{L}[\p{L}\p{M} .'-]*$/u.test(name) || name.split(/\s+/u).length > 4) return false;
  const intentful = detectIntent(name).intents.some((intent) => intent !== INTENTS.UNKNOWN);
  const grammarWords = /(?:^|\s)(?:a|an|the|and|or|of|for|to|in|on|at|with|interested|looking|want|need|please|my|your|who|what|how|hello|hi|yes|no|still|very|upset|worried|concerned|frustrated|angry|unhappy|confused|happy|sorry|لسا|مازلت|ما\s+زلت|متضايق|متضايقة|زعلان|زعلانة|قلقان|قلقانة|مستاء|مستاءة|مرتاح|مرتاحه|مرحبا|مرحبًا|أهلا|اهلا|شو|ماذا|كيف|هل|من|في|على|عن|إلى|الى|مع|بدي|أريد|اريد|مهتم|مهتمة|أحتاج|احتاج|أنا|انا|ακόμα|πολύ|αναστατωμένος|αναστατωμένη|θυμωμένος|θυμωμένη|ανήσυχος|ανήσυχη|λυπημένος|λυπημένη|ευχαριστημένος|ευχαριστημένη|και|σε|με|για|από|απο|είμαι|ειμαι|ενδιαφέρομαι)(?:$|\s)/iu;
  const roleWords = /^(?:ιδιοκτήτης|ιδιοκτήτρια|υπεύθυνος|υπεύθυνη|πελάτης|πελάτισσα|owner|director|manager|client|customer)$/iu;
  return !intentful && !grammarWords.test(name) && !roleWords.test(name);
}

function extractBareCustomerName(text) {
  const candidate = String(text || "").trim();
  return isPlausibleCustomerName(candidate) ? candidate : null;
}

function wasNameRequested(turn) {
  return /(?:what(?:'s| is) your name|may i (?:know|have) your name|name should i (?:include|use)|\bname\b.{0,70}\b(?:optional|if you want|if you'd like)\b|ما اسم(?:ك| حضرتك)?|شو اسم(?:ك)?|ما الاسم|ما الاسم الذي|الاسم.{0,70}اختياري|كيف ينادونك|πώς σας λένε|ποιο όνομα|όνομα.{0,70}προαιρετικό|ποιο είναι το όνομά σας)/iu.test(String(turn?.response || ""));
}

function normalizeEchoText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function echoesRecentAssistantReply(incoming, history = []) {
  const normalizedIncoming = normalizeEchoText(incoming);
  if (normalizedIncoming.length < 80 || !Array.isArray(history)) return false;
  return history.slice(-6).some((turn) => {
    const priorReply = turn?.response || (turn?.role === "assistant" ? turn.content : "");
    return normalizeEchoText(priorReply) === normalizedIncoming;
  });
}

function extractCustomerNeed(text) {
  const value = String(text || "").trim();
  const match = value.match(/^(?:i am interested in|i'm interested in|i’d like help with|i'd like help with|i want help with|i need help with|i need|looking for)\s+(.+)$/i) ||
    value.match(/^(?:أنا مهتم(?:ة)? بـ|انا مهتم(?:ة)? ب|مهتم(?:ة)? بـ|مهتم(?:ة)? ب|بدي مساعدة في|أريد مساعدة في|اريد مساعدة في|أحتاج إلى|احتاج الى)\s*(.+)$/u);
  if (!match) return null;
  const need = match[1].replace(/[.!،؟?]+$/u, "").replace(/\s+/gu, " ").trim();
  if (need.length < 2 || need.length > 160 || /\d{7,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(need)) return null;
  return need;
}

function namePrompt(language) {
  return localized(language, {
    arabic: "قبل أن نتابع، ما اسمك؟",
    greek: "Πριν συνεχίσουμε, πώς σας λένε;",
    english: "Before we continue, may I know your name?"
  });
}

function normalizeSmallTalk(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, "")
    .replace(/[؟?!.،,\s]+$/gu, "")
    .trim()
    .toLowerCase();
}

async function routeMessageResult({ userId, text, store, existingUser = null, preparedInbound = null }) {
  let incoming = String(text || "").trim();
  let lower = incoming.toLowerCase();
  let response;

  if (!incoming) {
    response = localized(detectMessageLanguage(text), { english: "Please send a text message.", arabic: "يرجى إرسال رسالة نصية.", greek: "Παρακαλώ στείλτε ένα μήνυμα κειμένου." });
    const history = await recordHistory(store, userId, incoming, response);
    return { response, shouldUseAi: false, ...history };
  }

  if (lower === "reset") {
    const user = await store.resetUser(userId);
    response = localized(detectMessageLanguage(incoming), { english: "Your saved details have been cleared.", arabic: "تم حذف بياناتك المحفوظة.", greek: "Τα αποθηκευμένα στοιχεία σας διαγράφηκαν." });
    const history = await recordHistory(store, userId, incoming, response);
    return { response, shouldUseAi: false, user, ...history };
  }

  const user = existingUser || await store.ensureUser(userId);
  const prepared = preparedInbound || await prepareInboundMessage({ userId, incoming, user, store });
  const { classification, safety, priority } = prepared;
  const statesNoProactivePreference = NO_PROACTIVE_CONTACT_OR_BOOKING.test(incoming);
  if (statesNoProactivePreference) {
    const conversationPreferences = { ...(user.profile?.conversationPreferences || {}), noProactiveBookingOrContact: true };
    if (typeof store.updateUser === "function") await store.updateUser(userId, (draft) => { draft.profile = { ...(draft.profile || {}), conversationPreferences }; });
    user.profile = { ...(user.profile || {}), conversationPreferences };
  }
  if (prepared.metadata.privacySafeQuestion) {
    incoming = prepared.metadata.privacySafeQuestion;
    lower = incoming.toLowerCase();
  }
  const requestedLanguage = detectExplicitLanguageRequest(incoming);
  if (requestedLanguage && !safety.restricted && !safety.risks.includes("privacy")) {
    const replies = {
      english: "Of course, we can continue in English. What would you like to know?",
      arabic: "أكيد، منكمّل بالعربي. شو حابب تعرف؟",
      greek: "Βεβαίως, μπορούμε να συνεχίσουμε στα ελληνικά. Τι θα θέλατε να μάθετε;"
    };
    response = replies[requestedLanguage];
    const metadata = { ...prepared.metadata, intent: { ...prepared.metadata.intent, language: requestedLanguage } };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, history });
  }
  const lastTurn = user.history?.[user.history.length - 1];
  const nameWasRequested = wasNameRequested(lastTurn);
  const explicitName = extractCustomerName(incoming);
  const language = nameWasRequested && !explicitName && ["arabic", "english", "greek"].includes(lastTurn?.metadata?.intent?.language)
    ? lastTurn.metadata.intent.language
    : classification.language;
  if (echoesRecentAssistantReply(incoming, user.history)) {
    response = localized(language, {
      english: "Understood. I’m here if you want me to clarify a specific point.",
      arabic: "تمام، أنا جاهز أوضّحلك أي نقطة إذا حبيت.",
      greek: "Κατανοητό. Είμαι εδώ αν θέλετε να διευκρινίσω κάποιο σημείο."
    });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }
  const existingNameIsPlausible = isPlausibleCustomerName(user.profile?.name);

  // Ignore and clear legacy greeting/question strings previously mis-saved as names.
  const privacyRisk = safety.risks.includes("privacy");
  const capturedName = privacyRisk ? null : prepared.metadata.customerNameCaptured ? user.profile?.name : explicitName || (nameWasRequested ? extractBareCustomerName(incoming) : null);
  if (user.profile?.name && !existingNameIsPlausible && typeof store.updateUser === "function") {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}) };
      delete draft.profile.name;
      delete draft.profile.nameSource;
      delete draft.profile.nameUpdatedAt;
    });
    delete user.profile.name;
    delete user.profile.nameSource;
    delete user.profile.nameUpdatedAt;
  }
  if (capturedName && (!existingNameIsPlausible || capturedName !== user.profile?.name) && typeof store.updateUser === "function") {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}), name: capturedName, nameSource: "customer_stated", nameUpdatedAt: new Date().toISOString() };
    });
    user.profile = { ...(user.profile || {}), name: capturedName, nameSource: "customer_stated" };
    prepared.metadata.customerNameCaptured = true;
  }

  if (capturedName && nameWasRequested && user.profile?.handover?.required && !hasLimitedHandoverScope(incoming)) {
    response = localized(language, {
      english: `Thank you, ${capturedName}. I’ve added your name to the specialist-review request. Is there one important detail you’d like the team to know?`,
      arabic: `شكرًا لك يا ${capturedName}. أضفت اسمك إلى طلب مراجعة المختص. هل هناك تفصيل مهم تود أن يعرفه الفريق؟`,
      greek: `Ευχαριστώ, ${capturedName}. Πρόσθεσα το όνομά σας στο αίτημα αξιολόγησης από ειδικό. Υπάρχει κάποια σημαντική λεπτομέρεια που θέλετε να γνωρίζει η ομάδα;`
    });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (user.profile?.handover?.required && hasLimitedHandoverScope(incoming) && !["denied", "revoked"].includes(consentFromText(incoming))) {
    const summary = { ...(user.profile.handover.summary || {}), sharingScope: "current_inquiry_only" };
    const handoverState = { ...user.profile.handover, sharingScope: "current_inquiry_only", summary };
    if (typeof store.updateUser === "function") {
      await store.updateUser(userId, (draft) => { draft.profile = { ...(draft.profile || {}), handover: handoverState }; });
    }
    user.profile = { ...(user.profile || {}), handover: handoverState };
    response = localized(language, {
      english: "Understood. I’ll keep the follow-up to a summary of this project inquiry and your name and WhatsApp contact only, without sharing the rest of this chat. Is there one project detail you’d like highlighted?",
      arabic: "تمام، رح نشارك ملخّص استفسارك عن المشروع واسمك ورقم واتساب للمتابعة بس، بدون باقي المحادثة. في تفصيل واحد بتحب نبرزه؟",
      greek: "Κατανοητό. Η συνέχεια θα περιλαμβάνει μόνο σύνοψη αυτού του ερωτήματος και το όνομα και το WhatsApp σας, όχι το υπόλοιπο ιστορικό. Υπάρχει ένα στοιχείο του έργου που θέλετε να τονιστεί;"
    });
    const metadata = { ...prepared.metadata, handoverScope: { value: "current_inquiry_only", source: "customer_requested" } };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, history });
  }

  const customerNeed = privacyRisk ? null : extractCustomerNeed(incoming);
  if (customerNeed && typeof store.updateUser === "function" && customerNeed !== user.profile?.need) {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}), need: customerNeed, needSource: "customer_stated", needUpdatedAt: new Date().toISOString() };
    });
    user.profile = { ...(user.profile || {}), need: customerNeed, needSource: "customer_stated" };
  }

  if (classification.intents.includes(INTENTS.GREETING) || classification.intents.includes(INTENTS.AGENT_IDENTITY)) {
    response = localized(language, {
      english: "Hello, I’m REFAL, REFALCO GROUP’s digital business agent. I can help with information about the group and its business areas, using approved sources.",
      arabic: "مرحبًا، أنا رِفال، الوكيل الرقمي للأعمال في مجموعة ريفالكو. أساعدك بمعلومات معتمدة عن المجموعة ومجالات عملها.",
      greek: "Γεια σας, είμαι η REFAL, ο ψηφιακός επιχειρηματικός εκπρόσωπος του REFALCO GROUP. Μπορώ να βοηθήσω με εγκεκριμένες πληροφορίες για τον όμιλο και τους τομείς δραστηριότητάς του."
    });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (classification.intents.includes(INTENTS.PROJECT_ENQUIRY)) {
    response = localized(language, {
      english: "I can help you explore whether the project may fit Refalco’s areas of work, though suitability needs a specialist review. What kind of project are you considering?",
      arabic: "أستطيع مساعدتك في استكشاف مدى ارتباط الفكرة بمجالات عمل ريفالكو، أما ملاءمتها فتحتاج إلى مراجعة مختص. ما نوع المشروع الذي تفكر فيه؟",
      greek: "Μπορώ να βοηθήσω να εξετάσουμε αν το έργο σχετίζεται με τους τομείς δραστηριότητας της Refalco· η καταλληλότητα χρειάζεται αξιολόγηση ειδικού. Τι είδους έργο σκέφτεστε;"
    });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  // A no-contact statement is a customer instruction, not an invitation to
  // start the handover flow. Acknowledge it directly when it is not bundled
  // with an actual information question; questions still continue through the
  // normal answer path, with contact permission kept denied/revoked.
  const currentConsent = consentFromText(incoming);
  const hasInformationQuestion = /[?؟;]/u.test(incoming) || /\b(?:what|which|how|when|where|can you|could you|do you)\b|(?:شو|كيف|متى|وين|فيكن|ممكن|ما هي)|(?:τι|πώς|πότε|πόσο|πού|μπορείτε)/iu.test(incoming);
  if (["denied", "revoked"].includes(currentConsent) && !hasInformationQuestion) {
    response = localized(language, {
      english: "Understood. I’ll keep this chat informational and won’t request specialist follow-up.",
      arabic: "تمام، رح خلي الحديث للمعلومات هون وما رح أطلب من الفريق يتواصل معك.",
      greek: "Κατανοητό. Θα συνεχίσουμε μόνο με ενημέρωση εδώ και δεν θα ζητήσω επικοινωνία από ειδικό."
    });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (statesNoProactivePreference && !hasInformationQuestion) {
    response = localized(language, {
      english: "Understood. I’ll keep the conversation informational; you can ask about booking or follow-up whenever you’re ready.",
      arabic: "تمام، رح خلي الحديث للمعلومات هون. إذا قررت تحجز أو تطلب متابعة، بتخبرني وقت ما بتكون جاهز.",
      greek: "Κατανοητό. Θα συνεχίσουμε μόνο με πληροφορίες· μπορείτε να ζητήσετε κράτηση ή επικοινωνία όποτε είστε έτοιμοι."
    });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (GREEKLISH_CLOSURE.test(incoming.trim())) {
    response = "Εντάξει. Είμαι εδώ αν χρειαστείτε κάτι άλλο.";
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  const lastAssistantAskedAboutSpecialist = isFreshSpecialistOffer(lastTurn);
  const explicitYes = /^(?:(?:yes|yeah|yep|sure|of course)(?:\s*[,،]?\s*please)?|please do|نعم(?:\s*[,،]?\s*(?:تواصل معي|تابع معي|من فضلك))?|(?:أيوه|ايوه|أكيد|اكيد|موافق(?:ة)?)(?:\s*[,،]?\s*(?:تواصل معي|تابع معي))?|تواصل معي|تابع معي|ναι|βεβαίως|φυσικά)[.!،\s]*$/iu.test(incoming);
  const referencedOfferTurn = findReferencedSpecialistOffer(user.history, incoming);
  const trackedOfferTurn = lastAssistantAskedAboutSpecialist ? lastTurn : referencedOfferTurn;
  let affirmativeToTrackedOffer = lastAssistantAskedAboutSpecialist && explicitYes || Boolean(referencedOfferTurn);
  const naturalDirectContactRequest = /\b(?:i|we)\s+(?:request|ask)\s+(?:(?:a|the)\s+)?(?:specialist|team)\s+(?:to\s+)?(?:contact|call)\s+me\b/iu.test(incoming);
  const directFollowUpRequest = /\b(?:please\s+)?(?:have|ask)\s+(?:a|the)\s+(?:specialist|team)\s+(?:to\s+)?follow\s+up\b|\bplease\s+arrange\s+(?:a\s+)?specialist\s+follow.?up\b/iu.test(incoming);
  const directConnectionRequest = /\b(?:please\s+)?connect\s+me\s+(?:to|with)\s+(?:someone|a\s+human|a\s+specialist|the\s+team)\b/iu.test(incoming);
  const directContactRequest = naturalDirectContactRequest || directFollowUpRequest || directConnectionRequest || /(?:please have (?:a|the) (?:specialist|team) contact me|ask (?:a|the) specialist to contact me|contact me about this|i want (?:a )?(?:human|specialist) to contact me|(?:i|we) (?:request|ask) (?:a|the) specialist to contact me|please (?:call|contact) me|have (?:someone|the team) call me|خلي\s*(?:ال)?مختص\s*يتواصل\s*معي|خلي\s*(?:ال)?فريق\s*يتواصل\s*معي|بدي\s*(?:حدا|شخص|مختص)\s*(?:من\s*الفريق\s*)?يتواصل\s*معي|اطلبوا\s*من\s*(?:ال)?مختص\s*يتواصل\s*معي|(?<![\p{L}\p{M}])تواصلوا\s+معي(?![\p{L}\p{M}])|ζητ(?:ώ|ήστε)\s+(?:από\s+)?(?:έναν?\s+)?ειδικ(?:ό|ός)|επικοινωνήστε\s+μαζί\s+μου(?:\s+για\s+αυτό)?|θέλω\s+(?:να\s+)?(?:επικοινωνήσει|μιλήσω\s+με)\s+(?:ένας?\s+)?ειδικ(?:ός|ό)|\bepikoinoniste\s+mazi\s+mu\b|\bthelo\s+na\s+miliso\s+me\s+(?:enan?\s+)?eidiko\b)/iu.test(incoming);
  const consentDecision = consentFromText(incoming);
  const consentDeniedOrRevoked = consentDecision === "revoked" || consentDecision === "denied";
  const storedConsentState = getConsentState({ user });
  const storedConsentDeclined = storedConsentState === "denied" || storedConsentState === "revoked";
  const storedConsentAt = Date.parse(user.consent?.followUpUpdatedAt || user.consent?.updatedAt || "");
  const trackedOfferAt = Date.parse(trackedOfferTurn?.metadata?.specialistOffer?.offeredAt || trackedOfferTurn?.at || "");
  const hasNewOfferSinceStoredDecline = Number.isFinite(storedConsentAt) && Number.isFinite(trackedOfferAt) && trackedOfferAt > storedConsentAt;
  if (storedConsentDeclined && !hasNewOfferSinceStoredDecline) affirmativeToTrackedOffer = false;
  if (!consentDeniedOrRevoked && (affirmativeToTrackedOffer || directContactRequest)) {
    const activeHandoverAlreadyRecorded = user.profile?.handover?.required === true &&
      ["open", "pending_review", "awaiting_review"].includes(user.profile.handover.status) &&
      storedConsentState === "granted";
    if (activeHandoverAlreadyRecorded) {
      response = localized(language, {
        english: "Your specialist-review request for this inquiry is already recorded. I can’t confirm when the team may respond.",
        arabic: "طلب مراجعة هالاستفسار من مختص مسجّل من قبل. ما فيني أكّد إمتى ممكن يوصلك رد.",
        greek: "Το αίτημά σας για αξιολόγηση από ειδικό έχει ήδη καταγραφεί για αυτό το ερώτημα. Δεν μπορώ να επιβεβαιώσω πότε θα απαντήσει η ομάδα."
      });
      const metadata = {
        ...prepared.metadata,
        handoverAlreadyRecorded: true,
        specialistFollowUp: { consented: true, purpose: "specialist_follow_up", trackedOffer: false }
      };
      const history = await recordHistory(store, userId, incoming, response, { metadata });
      return resultWithHistory({ response, user, metadata, history });
    }
    response = localized(language, {
      english: `I’ve recorded your request for a specialist to review this inquiry. I can’t confirm when they may respond.${!isPlausibleCustomerName(user.profile?.name) ? " If you want, you can share the name you’d like included; it’s optional." : ""}`,
      arabic: `سجّلت طلبك لمراجعة مختص بهالاستفسار. ما فيني أكّد إمتى ممكن يوصلك رد.${!isPlausibleCustomerName(user.profile?.name) ? " وإذا بتحب، فيك تعطيني الاسم اللي بدك ياه ينضاف للطلب، وهو اختياري." : ""}`,
      greek: `Κατέγραψα το αίτημά σας για αξιολόγηση αυτού του ερωτήματος από ειδικό. Δεν μπορώ να επιβεβαιώσω πότε θα απαντήσει.${!isPlausibleCustomerName(user.profile?.name) ? " Αν θέλετε, μπορείτε να δώσετε το όνομα που θα συμπεριληφθεί· είναι προαιρετικό." : ""}`
    });
    const validIntentIds = new Set(Object.values(INTENTS));
    const ignoredHandoverIntents = new Set([INTENTS.UNKNOWN, INTENTS.GREETING, INTENTS.SMALL_TALK, INTENTS.AGENT_IDENTITY]);
    const priorTurnIntents = Array.isArray(lastTurn?.metadata?.intent?.intents)
      ? [...new Set(lastTurn.metadata.intent.intents.filter((intent) => validIntentIds.has(intent) && !ignoredHandoverIntents.has(intent)))]
      : [];
    const handoverClassification = priorTurnIntents.length
      ? { ...classification, intents: priorTurnIntents }
      : classification;
    const inquiryTurn = referencedOfferTurn || (lastAssistantAskedAboutSpecialist ? lastTurn : null);
    const currentTurnAddsInquiry = directContactRequest && !affirmativeToTrackedOffer;
    const handover = handoverFor({
      user,
      userId,
      incoming,
      inquiry: currentTurnAddsInquiry ? incoming : inquiryTurn?.message || incoming,
      inquiryMetadata: currentTurnAddsInquiry ? prepared.metadata : inquiryTurn?.metadata || prepared.metadata,
      classification: handoverClassification,
      language,
      response
    });
    const metadata = { ...prepared.metadata, handover, specialistFollowUp: { consented: true, purpose: "specialist_follow_up", trackedOffer: affirmativeToTrackedOffer, offerSourceTurnId: referencedOfferTurn?.id || lastTurn?.id || null, requestedAt: new Date().toISOString() } };
    if (typeof store.updateUser === "function") {
      const handoverState = { required: true, status: "open", department: handover.routing.department, priority: handover.routing.priority, summary: handover.summary, nextAction: "Admin review and approved customer follow-up" };
      await store.updateUser(userId, (draft) => { draft.profile = { ...(draft.profile || {}), specialistFollowUp: metadata.specialistFollowUp, handover: handoverState }; });
      user.profile = { ...(user.profile || {}), specialistFollowUp: metadata.specialistFollowUp, handover: handoverState };
    }
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, handover, history });
  }

  if (capturedName &&
      !classification.intents.some((intent) => ![INTENTS.UNKNOWN, INTENTS.SMALL_TALK, INTENTS.GREETING].includes(intent))) {
    response = localized(language, {
      english: `Nice to meet you, ${capturedName}. How can I help?`,
      arabic: `تشرفت بك يا ${capturedName}. كيف يمكنني مساعدتك؟`,
      greek: `Χαίρω πολύ, ${capturedName}. Πώς μπορώ να βοηθήσω;`
    });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  // Safety and escalation decisions happen before name capture or AI retrieval.
  if (safety.restricted && !prepared.metadata.privacySafeQuestion) {
    response = restrictedRefalcoReply(incoming) || safeLocalizedFallback(safety.primary || incoming, language);
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (classification.intents.includes(INTENTS.COMPLAINT)) {
    const complaint = handleComplaint({ text: incoming, language, customer: user.profile, notes: incoming });
    response = complaint.customerMessage;
    const metadata = { ...prepared.metadata, complaint: { severity: complaint.severity, summary: complaint.internalNote || incoming } };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, history });
  }

  const existingState = user.profile?.existingClientState;
  const awaitingExistingClientReply = existingState && ["awaiting_identifier", "awaiting_verification"].includes(existingState.state);
  const suppliedExistingClientIdentifier = awaitingExistingClientReply && /^\s*(?:[A-Z]{2,8}[-/]?\d{3,}|\d{6,})\s*$/iu.test(incoming);
  const conciseVerificationAnswer = awaitingExistingClientReply && /^(?:yes|no|yeah|nope|ναι|όχι|نعم|لا|اي|إي|ما بدي|δεν θέλω)[.!،؟?\s]*$/iu.test(incoming.trim());
  if (isSafeProfileUpdateChannelQuestion(incoming)) {
    response = safeProfileUpdateChannelReply(language);
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }
  if (classification.intents.includes(INTENTS.EXISTING_CLIENT) || suppliedExistingClientIdentifier || conciseVerificationAnswer) {
    const current = user.profile?.existingClientState || beginExistingClientFlow();
    const identifier = /(?:client|customer|account|case|contract)[\s:#-]*[A-Za-z0-9_-]{3,}/iu.test(incoming) ? incoming : "";
    const state = identifier
      ? transitionExistingClientState(current, EVENTS.identifier_provided, { identifier })
      : transitionExistingClientState(current, EVENTS.detect);
    if (typeof store.updateUser === "function") await store.updateUser(userId, (draft) => { draft.profile = { ...(draft.profile || {}), existingClientState: state }; });
    response = existingClientReply(language, state);
    const metadata = { ...prepared.metadata, existingClientVerification: { ...state, identifierProvided: Boolean(identifier) } };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, history });
  }

  if (prepared.metadata.correction?.explicit) {
    const response = prepared.metadata.correction.field
      ? localized(language, {
        english: "Thanks for correcting that. I’ve updated the information for this conversation. Is there anything else about the request that should be corrected?",
        arabic: "شكرًا لتصحيح المعلومة. حدّثت البيانات الخاصة بهذه المحادثة. هل هناك أي جزء آخر يحتاج إلى تصحيح؟",
        greek: "Ευχαριστώ για τη διόρθωση. Ενημέρωσα την πληροφορία για αυτή τη συζήτηση. Υπάρχει κάτι ακόμη που χρειάζεται διόρθωση;"
      })
      : localized(language, {
        english: "Thanks for pointing that out. Which specific detail should I correct?",
        arabic: "شكرًا لتوضيح ذلك. ما المعلومة المحددة التي تريد تصحيحها؟",
        greek: "Ευχαριστώ για την επισήμανση. Ποια συγκεκριμένη πληροφορία θέλετε να διορθώσω;"
      });
    const metadata = { ...prepared.metadata };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, history });
  }

  const objection = detectObjection(incoming);
  // A hesitation cue must not swallow a concrete question in the same message.
  // Answer the requested fact first; the reply can still stay low pressure.
  const asksConcretePrice = classification.intents.includes(INTENTS.PRICING);
  const asksConcreteQuestion = asksConcretePrice || /[?؟;]|\b(?:what|which|how|when|where|can you|could you|do you)\b|(?:شو|كيف|متى|وين|فيكن|ممكن|ما هي)|(?:τι|πώς|πότε|πόσο|πού|μπορείτε)/iu.test(incoming);
  if (objection.isObjection && !asksConcreteQuestion) {
    const languageKey = language === "arabic" ? "ar" : language === "greek" ? "el" : "en";
    const response = safeFallbackData({ language: languageKey, category: objection.category }).text;
    const metadata = { ...prepared.metadata, objection: objectionResponse({ text: incoming, language: languageKey }) };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, history });
  }

  // Offer specialist follow-up for material non-formation cases only when the
  // customer has not declined it. Company setup stays in the answer-first flow.
  const followUpDeclined = storedConsentState === "denied" || storedConsentState === "revoked";
  if (priority.handoverRequired && !followUpDeclined && !user.profile?.conversationPreferences?.noProactiveBookingOrContact && !classification.intents.includes(INTENTS.COMPANY_FORMATION)) {
    response = localized(language, {
      english: "This sounds like a substantial business matter. I can help with the basics here, or—with your permission—ask a REFALCO specialist to follow up. Which would you prefer?",
      arabic: "واضح إن الموضوع مهم. فيني ساعدك بالمعلومات الأساسية هون، أو إذا بتحب أطلب من مختصّ من ريفالكو يتابع معك. شو بتفضّل؟",
      greek: "Ακούγεται σημαντικό επιχειρηματικό θέμα. Μπορώ να σας δώσω βασικές πληροφορίες εδώ ή, αν θέλετε, να ζητήσω επικοινωνία από ειδικό της REFALCO. Τι προτιμάτε;"
    });
    const metadata = { ...prepared.metadata, specialistOffer: { offered: true, consentRequired: true, offeredAt: new Date().toISOString() } };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, history });
  }

  const smallTalk = normalizeSmallTalk(incoming);
  if (/^(?:تمام|تمام شكرا|تمام شكرًا|لا شكرا|لا شكرًا|مش محتاج|no thanks|no thank you|thanks|thank you|ευχαριστώ|okay|ok|great)$/iu.test(smallTalk)) {
    response = /^(?:لا شكرا|لا شكرًا|مش محتاج|no thanks|no thank you|thanks|thank you|ευχαριστώ)$/iu.test(smallTalk)
      ? localized(language, { english: "You’re welcome. I’m here if another question comes up.", arabic: "على الرحب والسعة. أنا هنا إذا كان لديك أي سؤال آخر.", greek: "Παρακαλώ. Είμαι εδώ αν προκύψει κάποια άλλη ερώτηση." })
      : localized(language, { english: "Understood. What would you like to know?", arabic: "تمام. ما الذي تود معرفته؟", greek: "Κατανοητό. Τι θα θέλατε να μάθετε;" });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }
  if (/^(?:(?:انت|إنت|وانت|وأنت)\s+)?(?:كيفك|كيف حالك|شلونك|شو اخبارك|كيف امورك|كيف صحتك)(?:\s+(?:انت|إنت|يا رفا))?$/iu.test(smallTalk) || /^(?:how are you|how's it going|how do you do)(?:\s+(?:rafa|you))?$/i.test(smallTalk)) {
    const arabic = detectMessageLanguage(incoming) === "arabic";
    response = localized(language, { arabic: "تمام، الحمد لله! وإنت كيفك؟", greek: "Είμαι καλά, ευχαριστώ! Εσείς πώς είστε;", english: "I’m doing well, thanks! How are you?" });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (lower === "help") {
    response = helpText(language);
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (lower === "profile") {
    response = profileText(user);
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  const restrictedReply = restrictedRefalcoReply(incoming);
  if (restrictedReply) {
    response = restrictedReply;
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (["start", "hi", "hello", "hey", "مرحبا", "اهلا"].includes(lower)) {
    response = user.profile?.name
      ? localized(language, { arabic: "مرحبًا، كيف يمكنني مساعدتك؟", greek: "Γεια σας, πώς μπορώ να βοηθήσω;", english: "Hi, how can I help?" })
      : localized(language, { arabic: "مرحبًا، أنا رفا. كيف يمكنني مساعدتك؟", greek: "Γεια σας, είμαι η RAFA. Πώς μπορώ να βοηθήσω;", english: "Hi, I’m RAFA. How can I help?" });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  return { response: localized(language, { english: "I’m checking the approved Refalco information for you.", arabic: "أتحقق لك من معلومات ريفالكو المعتمدة.", greek: "Ελέγχω τις εγκεκριμένες πληροφορίες της Refalco για εσάς." }), shouldUseAi: true, user, metadata: prepared.metadata };
}

async function routeMessage({ userId, text, store }) {
  const result = await routeMessageResult({ userId, text, store });
  if (result.shouldUseAi) {
    const history = await recordHistory(store, userId, text, result.response, { metadata: result.metadata });
    result.turn = history.turn;
    result.turnId = history.turnId;
  }
  return result.response;
}

module.exports = { routeMessage, routeMessageResult, prepareInboundMessage, recordHistory, profileText, extractCustomerName, extractCustomerNeed, namePrompt, normalizeSmallTalk, isValidWhatsAppReplyKey, buildReplyEditPayload, persistWhatsAppSentMessage, isPlausibleCustomerName, wasNameRequested };
