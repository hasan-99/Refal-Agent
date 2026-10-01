const { detectMessageLanguage } = require("./language");
const { restrictedRefalcoReply } = require("./refalcoAnswer");
const { detectIntent, INTENTS } = require("./intent");
const { classifySafety, safeLocalizedFallback } = require("./safetyPolicy");
const { qualifyLead } = require("./leadQualification");
const { assessPriority } = require("./priorityRules");
const { handleComplaint } = require("./complaintWorkflow");
const {
  beginExistingClientFlow,
  transitionExistingClientState,
  existingClientCustomerMessage,
  EVENTS
} = require("./existingClientWorkflow");
const { createHandover } = require("./handover");

const HELP = [
  "RAFA replies inside WhatsApp from the linked business number.",
  "Commands:",
  "profile - show your saved details",
  "reset - clear your saved details",
  "Ask a Refalco question or request a meeting."
].join("\n");

async function recordHistory(store, userId, message, response, extra) {
  const handover = extra?.metadata?.handover;
  if (handover && typeof store.createHandover === "function") {
    await store.createHandover({ userId, ...handover });
  }
  const turn = await store.addHistory(userId, message, response, {
    automated: true,
    source: "whatsapp",
    ...(extra || {})
  });
  return { turn, turnId: turn?.id || null };
}

function localized(language, messages) {
  return messages[language] || messages.english;
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

function handoverFor({ user, userId, incoming, classification, priority, language, response }) {
  const intents = classification.intents.map((intent) => intent === INTENTS.LAND_DEVELOPMENT ? "development" : intent);
  return createHandover({
    input: incoming,
    customer: { name: user.profile?.name, phone: user.phone || userId },
    conversation: { lastMessage: incoming, need: user.profile?.need },
    intents,
    language,
    customerMessage: response
  });
}

async function prepareInboundMessage({ userId, incoming, user, store }) {
  const classification = detectIntent(incoming);
  const safety = classifySafety(incoming);
  const priority = assessPriority({ text: incoming, intents: classification.intents });
  const history = [...(user.history || []), { message: incoming }];
  const qualification = qualifyLead({ history, profile: user.profile || {}, booking: user.booking });
  if (typeof store.updateUser === "function") {
    await store.updateUser(userId, (draft) => {
      draft.profile = draft.profile || {};
      draft.profile.leadQualification = { ...qualification, updatedAt: new Date().toISOString(), source: "message_router_v1" };
    });
  }
  return {
    classification,
    safety,
    priority,
    qualification: { dimensions: qualification.dimensions, total: qualification.total, status: qualification.status },
    metadata: {
      intent: { primary: classification.primary, intents: classification.intents, isMultiIntent: classification.isMultiIntent, language: classification.language },
      safety: { restricted: safety.restricted, risks: safety.risks },
      priority: { level: priority.level, triggers: priority.triggers, handoverRequired: priority.handoverRequired },
      qualification: { dimensions: qualification.dimensions, total: qualification.total, status: qualification.status }
    }
  };
}

function resultWithHistory({ response, user, metadata, handover, history }) {
  return { response, shouldUseAi: false, user, metadata, handover, ...history };
}

function existingClientReply(language, state) {
  if (language === "greek") {
    if (state.state === "authenticated") return "Η ταυτότητά σας επαληθεύτηκε. Μπορώ πλέον να βοηθήσω με πληροφορίες που αφορούν τον λογαριασμό σας.";
    if (state.state === "locked") return "Δεν ήταν δυνατή η επαλήθευση. Για την ασφάλειά σας, επικοινωνήστε με την ομάδα της Refalco μέσω εγκεκριμένου καναλιού.";
    return "Για την προστασία του απορρήτου σας, παρακαλώ δώστε το εγκεκριμένο αναγνωριστικό ή στοιχείο επαλήθευσης του λογαριασμού σας. Δεν μπορώ να αποκαλύψω στοιχεία πριν από την επαλήθευση.";
  }
  return existingClientCustomerMessage(state);
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
    `Name: ${profile.name || "not set"}`,
    `Company/project: ${profile.company || "not set"}`,
    `Need: ${profile.needOverride || profile.need || "not set"}`
  ].join("\n");
}

function extractCustomerName(text) {
  const value = String(text || "").trim();
  const match = value.match(/^(?:my name is|i am|i'm|call me|(?:أنا|انا) اسمي|اسمي|أنا|انا)\s+(.+)$/iu);
  const candidate = (match ? match[1] : value).replace(/[.!،؟?]+$/u, "").trim();
  if (!candidate || candidate.length > 60 || /\d|[?؟]/u.test(candidate) || /^(?:كيفك|كيف حالك|مرحبا|أهلا|اهلا|تمام|شكرا|شكرًا|سلام)$/u.test(candidate)) return null;
  if (candidate.split(/\s+/u).length > 4 || /\b(?:hi|hello|hey|start|menu|profile|reset|help|book|meeting|appointment|what|how|why|when|where|tell|interested|looking|want|need|service|please|can|could|مرحبا|اهلا|ما|ماذا|هل|كيف|لماذا|وين|شو|اريد|أريد|بدي|مهتم|مهتمة|أحتاج|احتاج|موعد|اجتماع)\b/i.test(candidate)) return null;
  return candidate;
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

async function routeMessageResult({ userId, text, store, existingUser = null }) {
  const incoming = String(text || "").trim();
  const lower = incoming.toLowerCase();
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
  const prepared = await prepareInboundMessage({ userId, incoming, user, store });
  const { classification, safety, priority } = prepared;
  const language = classification.language;

  const customerNeed = extractCustomerNeed(incoming);
  if (customerNeed && typeof store.updateUser === "function" && customerNeed !== user.profile?.need) {
    await store.updateUser(userId, (draft) => {
      draft.profile = { ...(draft.profile || {}), need: customerNeed, needSource: "customer_stated", needUpdatedAt: new Date().toISOString() };
    });
    user.profile = { ...(user.profile || {}), need: customerNeed, needSource: "customer_stated" };
  }

  // Safety and escalation decisions happen before name capture or AI retrieval.
  if (safety.restricted) {
    response = restrictedRefalcoReply(incoming) || safeLocalizedFallback(safety.primary || incoming, language);
    const handover = priority.handoverRequired ? handoverFor({ user, userId, incoming, classification, priority, language, response }) : null;
    const history = await recordHistory(store, userId, incoming, response, { metadata: { ...prepared.metadata, ...(handover ? { handover } : {}) } });
    return resultWithHistory({ response, user, metadata: prepared.metadata, handover, history });
  }

  if (classification.intents.includes(INTENTS.COMPLAINT)) {
    const complaint = handleComplaint({ text: incoming, language, customer: user.profile, notes: incoming });
    response = complaint.customerMessage;
    const handover = handoverFor({ user, userId, incoming, classification, priority, language, response });
    const metadata = { ...prepared.metadata, handover };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, handover, history });
  }

  const existingState = user.profile?.existingClientState;
  if (classification.intents.includes(INTENTS.EXISTING_CLIENT) || existingState && ["awaiting_identifier", "awaiting_verification"].includes(existingState.state)) {
    const current = user.profile?.existingClientState || beginExistingClientFlow();
    const identifier = /(?:client|customer|account|case|contract)[\s:#-]*[A-Za-z0-9_-]{3,}/iu.test(incoming) ? incoming : "";
    const state = identifier
      ? transitionExistingClientState(current, EVENTS.identifier_provided, { identifier })
      : transitionExistingClientState(current, EVENTS.detect);
    if (typeof store.updateUser === "function") await store.updateUser(userId, (draft) => { draft.profile = { ...(draft.profile || {}), existingClientState: state }; });
    response = existingClientReply(language, state);
    const handover = handoverFor({ user, userId, incoming, classification, priority, language, response });
    const metadata = { ...prepared.metadata, handover };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, handover, history });
  }

  if (priority.handoverRequired && classification.intents.some((intent) => [INTENTS.LAND_DEVELOPMENT, INTENTS.CONSTRUCTION, INTENTS.INVESTMENT, INTENTS.PARTNERSHIP].includes(intent))) {
    response = localized(language, {
      english: "This sounds like an important opportunity. I’ll share it with the appropriate Refalco specialist for verified follow-up. What is the main scope or timeline?",
      arabic: "يبدو أن هذا موضوع مهم. سأشاركه مع مختص فريق ريفالكو للمتابعة الموثوقة. ما النطاق أو الإطار الزمني الأساسي؟",
      greek: "Αυτό φαίνεται να είναι σημαντική ευκαιρία. Θα το διαβιβάσω στον κατάλληλο ειδικό της Refalco για επαληθευμένη συνέχεια. Ποιο είναι το βασικό αντικείμενο ή χρονοδιάγραμμα;"
    });
    const handover = handoverFor({ user, userId, incoming, classification, priority, language, response });
    const metadata = { ...prepared.metadata, handover };
    const history = await recordHistory(store, userId, incoming, response, { metadata });
    return resultWithHistory({ response, user, metadata, handover, history });
  }

  const smallTalk = normalizeSmallTalk(incoming);
  if (/^(?:(?:انت|إنت|وانت|وأنت)\s+)?(?:كيفك|كيف حالك|شلونك|شو اخبارك|كيف امورك|كيف صحتك)(?:\s+(?:انت|إنت|يا رفا))?$/iu.test(smallTalk) || /^(?:how are you|how's it going|how do you do)(?:\s+(?:rafa|you))?$/i.test(smallTalk)) {
    const arabic = detectMessageLanguage(incoming) === "arabic";
    response = localized(language, { arabic: "تمام، الحمد لله! وإنت كيفك؟", greek: "Είμαι καλά, ευχαριστώ! Εσείς πώς είστε;", english: "I’m doing well, thanks! How are you?" });
    const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
    return resultWithHistory({ response, user, metadata: prepared.metadata, history });
  }

  if (!user.profile?.name && !["help", "profile"].includes(lower)) {
    const name = extractCustomerName(incoming);
    if (name && typeof store.updateUser === "function") {
      await store.updateUser(userId, (draft) => {
        draft.profile = { ...(draft.profile || {}), name };
        draft.step = null;
      });
      response = detectMessageLanguage(incoming) === "arabic"
        ? `تشرفت بك يا ${name}. كيف يمكنني مساعدتك؟`
        : language === "greek" ? `Χαίρω πολύ, ${name}. Πώς μπορώ να βοηθήσω;` : `Nice to meet you, ${name}. How can I help?`;
      const history = await recordHistory(store, userId, incoming, response, { metadata: prepared.metadata });
      return resultWithHistory({ response, user, metadata: prepared.metadata, history });
    }
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

module.exports = { routeMessage, routeMessageResult, prepareInboundMessage, profileText, extractCustomerName, extractCustomerNeed, namePrompt, normalizeSmallTalk, isValidWhatsAppReplyKey, buildReplyEditPayload, persistWhatsAppSentMessage };
