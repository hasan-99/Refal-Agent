"use strict";

// Structured per-conversation memory (RAFA_STRUCTURED_SESSION_MEMORY).
//
// What it is: a small, typed picture of what the CUSTOMER has told us in the
// active conversation (name, language, country, interests, requirements,
// tentative ideas, corrections, open questions) plus the real state of
// actions (handoff, booking, saved records) and of evidence use. It is
// rendered into the decision prompt as a bounded "customer context" block so
// the model does not have to re-derive it from a truncated transcript.
//
// What it is NOT: company evidence. Nothing in here can support a price,
// timeline, policy, legal/tax statement, guarantee, refund, availability,
// compliance or security claim. It never enters an observation, so neither the
// deterministic grounding gate nor the semantic reviewer can count it as
// evidence (see the M test in conversationMemoryFlow.integration.test.js).
//
// How it is built: deterministically, with no model call. Every turn it is
// re-folded from the persisted transcript of the active session, so it
// survives socket reconnects and process restarts. A small in-process overlay
// (keyed by the same contact key the session evidence cache uses) adds facts
// that only the live turn knows: agent outcome, evidence refs used, tool
// results and the handoff persistence result. Losing the overlay (restart)
// only makes the state more conservative, never more optimistic.
//
// Every item carries status (confirmed | tentative | unknown | corrected |
// inferred | system_verified), source (user | system | tool |
// approved_knowledge | agent_inference) and timestamps. Hedged wording never
// produces a confirmed item.

const { redactPersonalData } = require("./ai");
const { deriveOpenQuestion } = require("./openQuestion");
const { detectExplicitLanguageRequest } = require("./language");
const { findRepeatedQuestion } = require("./neverReAsk");

const STATUSES = Object.freeze(["confirmed", "tentative", "unknown", "corrected", "inferred", "system_verified"]);
const SOURCES = Object.freeze(["user", "system", "tool", "approved_knowledge", "agent_inference"]);
const HANDOFF_STATES = Object.freeze(["not_requested", "requested", "submitted", "queued", "accepted", "human_joined", "completed", "failed"]);
const BOOKING_STATES = Object.freeze(["none", "suggested", "selected", "pending_confirmation", "confirmed", "cancelled", "failed"]);

const LIMITS = Object.freeze({
  historyTurnsForName: 200, sessionTurns: 40, requirements: 6, tentative: 6, corrections: 6,
  openQuestions: 4, askedQuestions: 6, answersGiven: 8, toolResults: 6, interests: 4, valueChars: 120
});

const SOCIAL_INTENTS = new Set(["greeting", "small_talk", "agent_identity", "unknown", "prompt_injection", "unrelated", "language_capability"]);

// ---------------------------------------------------------------- text utils
// Matching form only. NFKC, tatweel and whitespace; letters are never folded
// (no alef / ya / ta-marbuta changes), so a stored value keeps its meaning.
function matchForm(text) {
  return String(text || "").normalize("NFKC").replace(/ـ/gu, "").replace(/\s+/gu, " ").trim();
}

function clip(text, max = LIMITS.valueChars) {
  const value = redactPersonalData(matchForm(text)).replace(/[\u0000-\u001f\u007f]/gu, " ");
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?؟\n])\s+/u).map((part) => part.trim()).filter(Boolean);
}

function splitClauses(text) {
  return matchForm(text).split(/(?<=[,;:.!?؟،؛\n])\s+|\s+(?:but|and then|بس|لكن|ولكن|αλλά)\s+/iu).map((part) => part.trim()).filter(Boolean);
}

function isQuestionText(text) {
  const value = String(text || "").trim();
  if (/[?؟]\s*["'”»)]*$/u.test(value)) return true;
  return /[Ͱ-Ͽ]/u.test(value) && /;\s*$/u.test(value);
}

// Hedges: maybe / possibly / thinking about / might, and Arabic and Greek
// equivalents. A clause with any of them can never become "confirmed".
const HEDGE = /\b(?:maybe|perhaps|possibly|probably|might|may\s+(?:need|want|have|go|use|start|be)|could\s+(?:need|want|be)|thinking\s+(?:about|of)|considering|not\s+sure|i\s+guess|undecided|not\s+decided)\b|ربما|يمكن|ممكن|احتمال|يحتمل|أفكر|افكر|بفكر|عم\s*فكر|عم\s*نفكر|نفكر|مش\s+متأكد|مو\s+متأكد|مش\s+أكيد|مو\s+أكيد|لسا\s+ما\s+قررنا|μάλλον|ίσως|πιθανόν|πιθανώς|σκέφτομαι|σκεφτόμαστε|ενδεχομένως|δεν\s+είμαι\s+σίγουρ/iu;

function isHedged(text) {
  return HEDGE.test(matchForm(text));
}

const NEGATION = /\b(?:not|no|never|don't|doesn't|didn't|isn't|aren't|wasn't|haven't|hasn't|cannot|can't|unable|without|unconfirmed|unknown)\b|(?:^|\s)(?:لا|ليس|ليست|لست|مش|مو|ما|لم|لن|غير|بدون|مب)(?=\s|$)|\b(?:δεν|όχι|χωρίς|μην)\b/iu;

// ---------------------------------------------------------------- names
function isPlausibleName(value) {
  // messageRouter owns the plausibility rules; loaded lazily to avoid a cycle.
  try { return require("./messageRouter").isPlausibleCustomerName(value); } catch { return false; }
}

function cleanNameToken(value) {
  return String(value || "").replace(/^[\s"'“”«»(]+|[\s"'“”«».,!،؟?;:)]+$/gu, "").trim();
}

// "I'm not X" / "أنا مش X" are weak: they also mean "I'm not sure" etc., so
// they only count when X is the current name or a name the assistant used.
const WEAK_NAME_NEGATIONS = new Set([1, 5]);
const NAME_NEGATION_PATTERNS = [
  /\bmy\s+name\s+(?:is\s+not|isn['’]t|'s\s+not|is\s+no\s+longer)\s+([\p{L}\p{M}'-]+)/iu,
  /\b(?:i\s+am\s+not|i['’]m\s+not)\s+([\p{L}\p{M}'-]+)\s*(?=[,.;!]|$)/iu,
  /\b(?:don['’]t|do\s+not|please\s+don['’]t|stop)\s+call(?:ing)?\s+me\s+([\p{L}\p{M}'-]+)/iu,
  /\bnot\s+([\p{L}\p{M}'-]+)\s*[,;]\s*(?:it['’]?s|it\s+is|my\s+name\s+is|call\s+me|i['’]m|i\s+am)\b/iu,
  /(?:أنا\s+)?اسمي\s+(?:مش|مو|ليس|مب|مهو|ما\s+هو|ما\s+بيكون)\s+([\p{L}\p{M}]+)/u,
  /(?:أنا|انا)\s+(?:مش|مو|لست|مب)\s+([\p{L}\p{M}]+)\s*(?=[،,.!؟]|$)/u,
  /(?:لا\s+|ما\s+)(?:تناديني|تقلي|تقل\s+لي|تقول\s+لي|تسميني)\s+([\p{L}\p{M}]+)/u,
  /δεν\s+(?:με\s+λένε|με\s+λενε|λέγομαι|λεγομαι|ονομάζομαι|ονομαζομαι|είμαι\s+(?:ο|η)|ειμαι\s+(?:ο|η))\s+([\p{L}\p{M}]+)/iu,
  /το\s+όνομά\s+μου\s+δεν\s+είναι\s+([\p{L}\p{M}]+)/iu
];

const NAME_AFTER_NEGATION = /^(?:(?:it['’]?s|it\s+is|its|actually|rather|but|instead)\s+)*(?:my\s+name\s+is\s+|call\s+me\s+|i['’]m\s+|i\s+am\s+)?([\p{L}\p{M}'-]+(?:\s+[\p{L}\p{M}'-]+)?)[.!،,؟?]*$/iu;
const AR_NAME_AFTER_NEGATION = /^(?:بل\s+|لا\s*[،,]?\s*|اسمي\s+|أنا\s+|انا\s+|هو\s+)*([\p{L}\p{M}]+)[.!،,؟?]*$/u;
const EL_NAME_AFTER_NEGATION = /^(?:αλλά\s+|με\s+λένε\s+|λέγομαι\s+|είμαι\s+(?:ο|η)\s+)*([\p{L}\p{M}]+)[.!,;]*$/iu;

/**
 * Parses one customer message for name statements. Returns the positive name
 * (if any), names the customer explicitly rejected, and whether the customer
 * asked us to forget their details. A negated name is never returned as the
 * positive name ("My name is not Sami" never yields "not Sami").
 */
function parseNameStatement(text) {
  const value = matchForm(text);
  const result = { name: null, rejected: [], weakRejected: [], forget: isForgetRequest(value), hedged: false };
  if (!value) return result;
  let negated = false;
  NAME_NEGATION_PATTERNS.forEach((pattern, index) => {
    const match = value.match(pattern);
    const candidate = cleanNameToken(match?.[1]);
    if (!candidate || !isPlausibleName(candidate)) return;
    const target = WEAK_NAME_NEGATIONS.has(index) ? result.weakRejected : result.rejected;
    if (!target.some((name) => sameName(name, candidate))) target.push(candidate);
    negated = true;
  });
  result.weakRejected = result.weakRejected.filter((name) => !result.rejected.some((strong) => sameName(strong, name)));
  const clauses = value.split(/(?<=[,;:.!?؟،؛])\s+|\s+(?:but|بل|لكن|αλλά)\s+/iu).map((part) => part.trim()).filter(Boolean);
  const explicit = (clause) => {
    try { return require("./messageRouter").extractExplicitCustomerName(clause, { ignoreFlag: true }); } catch { return null; }
  };
  for (const clause of clauses) {
    const negClause = NAME_NEGATION_PATTERNS.some((pattern) => pattern.test(clause));
    if (negClause) continue;
    let candidate = explicit(clause);
    if (!candidate) {
      const callMe = clause.match(/\bcall\s+me\s+([\p{L}\p{M}'-]+)/iu);
      if (callMe && !/\b(?:don['’]t|do\s+not|never)\s+call\s+me\b/iu.test(clause)) candidate = cleanNameToken(callMe[1]);
    }
    if (!candidate && negated) {
      const match = clause.match(NAME_AFTER_NEGATION) || clause.match(AR_NAME_AFTER_NEGATION) || clause.match(EL_NAME_AFTER_NEGATION);
      candidate = cleanNameToken(match?.[1]);
    }
    candidate = cleanNameToken(candidate);
    if (candidate && isPlausibleName(candidate) && ![...result.rejected, ...result.weakRejected].some((name) => sameName(name, candidate))) {
      result.name = candidate;
      result.hedged = isHedged(clause);
    }
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Whole-word (letter-boundary) match, Unicode aware. */
function containsWord(text, word) {
  if (!word) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{M}])${escapeRegExp(word)}(?:$|[^\\p{L}\\p{M}])`, "iu").test(String(text || ""));
}

function sameName(a, b) {
  const form = (v) => String(v || "").normalize("NFKC").toLocaleLowerCase().replace(/[ً-ٰٟـ]/gu, "").replace(/\s+/gu, " ").trim();
  return Boolean(a && b) && form(a) === form(b);
}

/**
 * Folds the transcript forward. A later rejection of the current name clears
 * it (and records it as corrected); a later explicit name replaces it; a
 * "forget my details" request clears it. Never reverts to an older value.
 */
function foldConfirmedName(history = [], { currentMessage = null, now = Date.now() } = {}) {
  const turns = (Array.isArray(history) ? history : []).slice(-LIMITS.historyTurnsForName);
  const texts = turns.map((turn) => ({ text: typeof turn?.message === "string" ? turn.message : typeof turn?.text === "string" ? turn.text : "",
    at: turn?.at || null, turnId: turn?.id || null, response: typeof turn?.response === "string" ? turn.response : "" }));
  if (typeof currentMessage === "string" && currentMessage.trim()) texts.push({ text: currentMessage, at: new Date(now).toISOString(), turnId: "current" });
  let name = null;
  const corrected = [];
  let forgotten = false;
  let previousResponse = "";
  for (const entry of texts) {
    const parsed = parseNameStatement(entry.text);
    const usedByAssistant = (value) => containsWord(previousResponse, value);
    parsed.rejected.push(...parsed.weakRejected.filter((value) => (name && sameName(name.value, value)) || usedByAssistant(value)));
    previousResponse = entry.response || "";
    if (parsed.forget) {
      if (name) corrected.push({ value: name.value, reason: "forgotten", at: entry.at, turnId: entry.turnId });
      name = null; forgotten = true;
      continue;
    }
    for (const rejected of parsed.rejected) {
      if (!corrected.some((item) => sameName(item.value, rejected))) corrected.push({ value: rejected, reason: "rejected", at: entry.at, turnId: entry.turnId });
      if (name && sameName(name.value, rejected)) name = null;
    }
    if (parsed.name) {
      if (name && !sameName(name.value, parsed.name)) corrected.push({ value: name.value, reason: "replaced", at: entry.at, turnId: entry.turnId });
      name = item("name", parsed.name, parsed.hedged ? "tentative" : "confirmed", "user", entry.at, entry.turnId, name?.firstSeenAt);
      forgotten = false;
    }
  }
  return { name, corrected: corrected.slice(-LIMITS.corrections), forgotten };
}

// ---------------------------------------------------------------- requests
const FORGET = /\b(?:forget|delete|erase|remove|wipe)\s+(?:all\s+)?(?:of\s+)?(?:my|me)\b(?:\s+(?:personal\s+)?(?:name|details|data|information|info|number))?|\b(?:don['’]t|do\s+not)\s+(?:store|keep|remember|save)\s+my\b|(?:انس[ىي]|إنس[ىي]|امسح|إمسح|احذف|إحذف|امح|شيل)\s*(?:كل\s*)?(?:اسمي|بياناتي|معلوماتي|تفاصيلي|رقمي)|(?:لا\s+|ما\s+)(?:تحفظ|تخزن|تسجل)\s*(?:اسمي|بياناتي|معلوماتي)|(?:ξέχνα|ξέχασε|ξεχάστε|διαγράψτε|διάγραψε|σβήστε)\s+(?:το\s+όνομά\s+μου|τα\s+στοιχεία\s+μου|τα\s+δεδομένα\s+μου)/iu;
function isForgetRequest(text) {
  return FORGET.test(matchForm(text));
}

let recapPattern = null;
function isRecapRequest(text) {
  const value = matchForm(text);
  if (!recapPattern) {
    try { recapPattern = require("./conversationRecap").RECAP_REQUEST; } catch { recapPattern = /$^/u; }
  }
  return recapPattern.test(value)
    || /\b(?:what\s+(?:have|did)\s+we\s+(?:discuss|discussed|talk(?:ed)?\s+about|agree(?:d)?)|summari[sz]e\s+(?:this|our|the\s+conversation|what\s+we)|give\s+me\s+a\s+(?:summary|recap))\b|(?:شو|ماذا|ما\s+الذي)\s+(?:حكينا|تحدثنا|ناقشنا|اتفقنا)|لخ(?:ّ)?ص(?:لي|ي)?\s+(?:المحادثة|حديثنا|يلي\s+حكيناه|ما\s+ناقشناه)|ملخص\s+(?:المحادثة|حديثنا)|(?:τι\s+(?:συζητήσαμε|είπαμε)|σύνοψη\s+της\s+συζήτησης)/iu.test(value);
}

const OWN_DETAIL_QUESTION = /\bwhat(?:'s|\s+is|\s+was)\s+my\s+(?:name|company(?:\s+name)?|country|budget|email|number|business)\b|\b(?:do\s+you\s+)?(?:remember|know)\s+my\s+(?:name|company|details)\b|\bwho\s+am\s+i\b|(?:شو|ما|ايش|إيش)\s+(?:هو\s+)?(?:اسمي|اسم\s+شركتي|شركتي|بلدي|ميزانيتي|رقمي)|(?:بتتذكر|تتذكر|بتعرف|تعرف)\s+(?:اسمي|شركتي)|(?:πώς\s+με\s+λένε|ποιο\s+είναι\s+το\s+όνομά\s+μου|θυμάσαι\s+το\s+όνομά\s+μου)/iu;
const COMPANY_FACT_CUE = /\b(?:price|prices|pricing|cost|costs|fee|fees|how\s+much|refund|refunds|deadline|policy|policies|how\s+long|timeline|documents?|requirements?|eligib\w*|hours|open(?:ing)?|guarantee\w*|included?|includes|package|vat|tax|licen[cs]e|permit|bank|account|office|service|services|process|procedure|available|availability|discount|offer|payment|hosting|gdpr|encrypt\w*|retention|data)\b|سعر|أسعار|اسعار|كلفة|تكلفة|رسوم|قديش|كم\s+(?:سعر|كلفة|بكلف|تكلف)|استرداد|استرجاع|مهلة|سياسة|مدة|وثائق|مستندات|أوراق|شروط|ضمان|باقة|ضريبة|ترخيص|رخصة|حساب\s+بنكي|خدمة|خدمات|إجراءات|متوفر|خصم|عرض|دفع|استضافة|تشفير|بيانات|τιμή|κόστος|τέλη|επιστροφή|προθεσμία|πολιτική|έγγραφα|πακέτο|φόρος|άδεια|υπηρεσ/iu;

/**
 * Knowledge Gaps integration point (RAFA_KNOWLEDGE_GAPS, built separately).
 * Distinguishes "company knowledge missing" (a KB gap candidate, e.g. "what's
 * your refund deadline?") from "the customer's own detail is unknown" (NOT a
 * KB gap, e.g. "what is my company name?"). Pure and deterministic.
 *
 * Intended one-line call site in the Gaps feature, where an unanswered turn is
 * about to be recorded:
 *   if (!classifyUnansweredReason({ message, intents, sessionState }).kbGapCandidate) return;
 */
function classifyUnansweredReason({ message = "", intents = [], sessionState = null } = {}) {
  const text = matchForm(message);
  const list = Array.isArray(intents) ? intents.filter((intent) => typeof intent === "string") : [];
  if (!text) return { reason: "not_applicable", kbGapCandidate: false };
  if (OWN_DETAIL_QUESTION.test(text)) {
    const knownName = sessionState?.user?.name?.status === "confirmed";
    const asksName = /\bname\b|اسمي|όνομά/iu.test(text) && !/company|شركتي|εταιρ/iu.test(text);
    return { reason: asksName && knownName ? "answerable_from_session" : "user_memory_unknown", kbGapCandidate: false };
  }
  if (list.length && list.every((intent) => SOCIAL_INTENTS.has(intent)) && !list.includes("unknown")) return { reason: "not_applicable", kbGapCandidate: false };
  if (list.includes("prompt_injection")) return { reason: "not_applicable", kbGapCandidate: false };
  const factualIntent = list.some((intent) => !SOCIAL_INTENTS.has(intent) && !["appointment", "contact", "existing_client", "privacy"].includes(intent));
  if (factualIntent || COMPANY_FACT_CUE.test(text)) return { reason: "company_knowledge_missing", kbGapCandidate: true };
  return { reason: "unclear_request", kbGapCandidate: false };
}

// ---------------------------------------------------------------- signals
const REQUIREMENT_TRIGGER = /\b(?:we|i)\s+(?:(?:will|would|may|might|could|probably)\s+)?(?:need|require|want|must\s+have|have\s+to\s+have)\b|\b(?:it|this|the\s+\w+)\s+(?:must|has\s+to|needs\s+to)\b|\bmust\s+(?:support|have|be|include)\b|\b(?:our|my)\s+(?:main\s+)?requirement\b|(?:بدنا|بدي|نحتاج|نحتاجه|احتاج|أحتاج|نريد|أريد|اريد|لازم|ضروري|يجب|مطلوب)|(?:χρειαζόμαστε|χρειάζομαι|θέλουμε|θέλω|πρέπει|απαιτείται)/iu;
const INFO_SEEKING = /\b(?:want|need)\s+to\s+(?:know|ask|understand|check|find\s+out|learn)\b|\b(?:i|we)\s+(?:want|need)\s+(?:some\s+)?(?:info|information|details|help|advice)\b|(?:بدي|أريد|اريد|بدنا|نريد)\s+(?:أعرف|اعرف|نعرف|أسأل|اسأل|نسأل|أفهم|افهم|استفسر|أستفسر|معلومات|مساعدة)|(?:θέλω|θέλουμε)\s+να\s+(?:μάθω|μάθουμε|ρωτήσω|καταλάβω)/iu;
const DOWNGRADE = /\b(?:(?:was|is)\s+(?:just|only)\s+(?:an?\s+)?(?:idea|option|thought|suggestion)|not\s+(?:yet\s+)?(?:decided|final)|that\s+was\s+(?:just|only)\s+(?:an?\s+)?(?:idea|option|thought)|(?:that['’]s|that\s+is|it['’]s|it\s+is|this\s+is)\s+not\s+(?:confirmed|decided|final|a\s+(?:firm\s+)?requirement)|(?:i|we)\s+(?:didn['’]t|did\s+not|haven['’]t|have\s+not)\s+(?:decide|decided|confirm|confirmed|say\s+(?:that\s+)?(?:it\s+was\s+)?(?:final|confirmed|required))|not\s+(?:a\s+)?(?:firm|final)\s+(?:requirement|decision)|i\s+said\s+maybe|only\s+tentative)\b|(?:كانت?\s+)?مجرد\s+(?:فكرة|اقتراح|احتمال)|(?:مش|مو|ليس|ليست)\s+(?:مؤكد|مؤكدة|نهائي|نهائية|أكيد|اكيد|قرار)|(?:لسا\s+|بعد\s+)?ما\s+(?:قررنا|أكدنا|حسمنا)|قلت\s+(?:ربما|يمكن|ممكن)|δεν\s+(?:είναι\s+)?(?:σίγουρο|οριστικό|αποφασισμένο)|δεν\s+(?:αποφασίσαμε|επιβεβαίωσα)/iu;

const COUNTRIES = [
  ["Cyprus", /\bcyprus\b|قبرص|κύπρ[οου]/iu], ["Greece", /\bgreece\b|اليونان|ελλάδα/iu], ["Lebanon", /\blebanon\b|لبنان/iu],
  ["United Arab Emirates", /\b(?:uae|emirates|dubai|abu\s+dhabi)\b|الإمارات|الامارات|دبي|أبوظبي|ابوظبي/iu],
  ["Saudi Arabia", /\bsaudi(?:\s+arabia)?\b|السعودية/iu], ["Jordan", /\bjordan\b|الأردن|الاردن/iu], ["Egypt", /\begypt\b|مصر/iu],
  ["Syria", /\bsyria\b|سوريا|سورية/iu], ["Iraq", /\biraq\b|العراق/iu], ["Turkey", /\bturkey\b|\btürkiye\b|تركيا/iu],
  ["Qatar", /\bqatar\b|قطر/iu], ["Kuwait", /\bkuwait\b|الكويت/iu], ["Oman", /\boman\b|عُمان|سلطنة\s+عمان/iu], ["Bahrain", /\bbahrain\b|البحرين/iu],
  ["United Kingdom", /\b(?:uk|united\s+kingdom|britain|england|london)\b|بريطانيا|لندن/iu], ["Germany", /\bgermany\b|ألمانيا|المانيا/iu],
  ["Russia", /\brussia\b|روسيا|ρωσία/iu], ["Ukraine", /\bukraine\b|أوكرانيا|اوكرانيا/iu], ["Israel", /\bisrael\b|إسرائيل/iu],
  ["India", /\bindia\b|الهند/iu], ["China", /\bchina\b|الصين/iu], ["United States", /\b(?:usa|united\s+states|america)\b|أمريكا|امريكا|الولايات\s+المتحدة/iu]
];
const RESIDENCE_TRIGGER = /\b(?:i\s+am|i['’]m|we\s+are|we['’]re|i\s+live|we\s+live|living|located|based|operating|registered|my\s+company\s+is|our\s+company\s+is)\s+(?:currently\s+)?(?:in|from)\b|(?:أنا|انا|احنا|إحنا|نحن)\s+(?:من|في|ب)(?=\s|[\p{L}])|(?:ساكن|ساكنة|مقيم|مقيمة|عايش|عايشة|مقرنا|شركتنا|شركتي|موجود|موجودين)\s+(?:في|ب)|(?:μένω|μένουμε|είμαι|είμαστε|βρίσκομαι|εδρεύουμε)\s+(?:στ|από)/iu;

const CUSTOMER_TYPE = [
  ["business", /\b(?:i\s+(?:own|run|have)\s+a\s+(?:company|business)|we\s+are\s+a\s+(?:company|business|startup|firm)|my\s+company|our\s+company)\b|(?:عندي|عنا|لدي|لدينا)\s+شركة|(?:أنا|انا)\s+صاحب(?:ة)?\s+شركة|(?:نحن|احنا)\s+شركة|η\s+εταιρεία\s+μου|έχω\s+εταιρεία/iu],
  ["individual", /\b(?:as\s+an\s+individual|for\s+myself|personally|private\s+person|not\s+a\s+company)\b|بشكل\s+شخصي|(?:أنا|انا)\s+فرد|لحالي\s+مش\s+شركة|ως\s+ιδιώτης/iu]
];

const CHANNEL_PREFERENCE = /\b(?:i|we)\s+prefer\s+(?:to\s+(?:keep\s+it|stay|continue)\s+(?:on|in)\s+)?(whatsapp|written|writing|text|messages?|email|calls?)\b|\b(?:please\s+)?(?:don['’]t|do\s+not)\s+call\s+me\b|\b(?:in\s+writing|written\s+only)\s+please\b|(?:بفضل|أفضل|افضل|بحب)\s+(?:التواصل\s+)?(?:على\s+)?(?:واتساب|الواتساب|كتابة|كتابي|رسائل|الإيميل|ايميل)|(?:لا|ما)\s+(?:تتصل|تتصلوا|تحكيني\s+تلفون)|(?:προτιμώ|προτιμούμε)\s+(?:γραπτ|μηνύματ|whatsapp|email)/iu;

function extractCustomerSignals(text) {
  const value = matchForm(text);
  const signals = { requirements: [], country: null, preferredLanguage: null, customerType: null, channelPreference: null,
    downgrade: false, forget: isForgetRequest(value), recap: isRecapRequest(value), question: isQuestionText(value) };
  if (!value) return signals;
  signals.downgrade = DOWNGRADE.test(value);
  const requested = detectExplicitLanguageRequest(value);
  if (requested) {
    const clause = splitClauses(value).find((part) => detectExplicitLanguageRequest(part) === requested) || value;
    signals.preferredLanguage = { value: requested, tentative: isHedged(clause) };
  }
  for (const clause of splitClauses(value)) {
    if (isQuestionText(clause) || DOWNGRADE.test(clause)) continue;
    if (REQUIREMENT_TRIGGER.test(clause) && !INFO_SEEKING.test(clause) && clause.length >= 6) {
      signals.requirements.push({ value: clip(clause.replace(/[.!،,;؛]+$/u, "")), tentative: isHedged(clause) });
    }
    if (!signals.country && RESIDENCE_TRIGGER.test(clause)) {
      const tail = clause.slice(clause.search(RESIDENCE_TRIGGER));
      const found = COUNTRIES.find(([, pattern]) => pattern.test(tail.slice(0, 80)));
      if (found) signals.country = { value: found[0], tentative: isHedged(clause), qualifier: /\bfrom\b|(?:أنا|انا|احنا|نحن)\s+من|από/iu.test(tail.slice(0, 40)) ? "origin" : "residence" };
    }
  }
  // Hedging is judged on the clause that states the detail, not the message.
  const clauseFor = (pattern) => splitClauses(value).find((part) => pattern.test(part) && !isQuestionText(part)) || null;
  for (const [type, pattern] of CUSTOMER_TYPE) {
    const clause = clauseFor(pattern);
    if (clause) { signals.customerType = { value: type, tentative: isHedged(clause) }; break; }
  }
  const channelClause = clauseFor(CHANNEL_PREFERENCE);
  const channel = channelClause?.match(CHANNEL_PREFERENCE);
  if (channel) signals.channelPreference = { value: clip(channel[0], 60), tentative: isHedged(channelClause) };
  return signals.requirements.length > LIMITS.requirements ? { ...signals, requirements: signals.requirements.slice(-LIMITS.requirements) } : signals;
}

// ---------------------------------------------------------------- items
function item(key, value, status, source, at = null, turnId = null, firstSeenAt = null) {
  const stamp = at || new Date().toISOString();
  return { key, value, status: STATUSES.includes(status) ? status : "unknown", source: SOURCES.includes(source) ? source : "system",
    firstSeenAt: firstSeenAt || stamp, updatedAt: stamp, turnId: turnId || null };
}

function intentLabel(intent) {
  return String(intent || "").replace(/_/gu, " ").slice(0, 40);
}

function businessIntents(intents) {
  return (Array.isArray(intents) ? intents : []).filter((intent) => typeof intent === "string" && !SOCIAL_INTENTS.has(intent)
    && !["complaint", "prompt_injection", "privacy"].includes(intent));
}

function normalizedQuestion(text) {
  return matchForm(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

function tokenSimilarity(a, b) {
  const left = new Set(normalizedQuestion(a).split(" ").filter((t) => t.length > 1));
  const right = new Set(normalizedQuestion(b).split(" ").filter((t) => t.length > 1));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

// ---------------------------------------------------------------- actions
const HANDOVER_STATUS_MAP = Object.freeze({ open: "submitted", queued: "queued", acknowledged: "accepted", accepted: "accepted",
  human_joined: "human_joined", resolved: "completed", completed: "completed", failed: "failed" });

function deriveHandoffState({ user = {}, sessionTurns = [], overlayByTurn = new Map(), currentTurn = {} } = {}) {
  const profileHandover = user?.profile?.handover;
  if (profileHandover && typeof profileHandover === "object" && profileHandover.id && HANDOVER_STATUS_MAP[profileHandover.status]) {
    return { status: HANDOVER_STATUS_MAP[profileHandover.status], source: "system", verified: true, at: profileHandover.updatedAt || profileHandover.createdAt || null };
  }
  if (currentTurn.handoverRequested) {
    if (currentTurn.handoverPersisted === true) return { status: "submitted", source: "system", verified: true, at: currentTurn.at || null };
    if (currentTurn.handoverPersisted === false) return { status: "failed", source: "system", verified: true, at: currentTurn.at || null };
    return { status: "requested", source: "user", verified: false, at: currentTurn.at || null };
  }
  for (const turn of [...sessionTurns].reverse()) {
    const overlay = overlayByTurn.get(turn?.id);
    if (overlay?.handoffStatus && HANDOFF_STATES.includes(overlay.handoffStatus)) return { status: overlay.handoffStatus, source: "system", verified: overlay.handoffStatus !== "requested", at: turn.at || null };
    if (turn?.metadata?.handover || turn?.metadata?.specialistFollowUp?.consented) return { status: "requested", source: "user", verified: false, at: turn.at || null };
  }
  if (currentTurn.specialistRequested) return { status: "requested", source: "user", verified: false, at: currentTurn.at || null };
  return { status: "not_requested", source: "system", verified: true, at: null };
}

const BOOKING_STATUS_MAP = Object.freeze({ awaiting_slot_choice: "suggested", awaiting_confirmation: "pending_confirmation", creating: "pending_confirmation",
  pending_calendar: "pending_confirmation", pending_review: "pending_confirmation", cancelled: "cancelled", failed: "failed" });

/**
 * REFAL's booking is a real, deterministic workflow (src/booking.js) that
 * owns appointment turns; the Agent only observes its state. The Agent itself
 * can never move a booking beyond "suggested": confirmation is reported only
 * when the workflow stored a booked appointment with a calendar event.
 */
function deriveBookingState({ user = {}, toolResults = [] } = {}) {
  const booking = user?.booking;
  const status = booking?.status;
  if (status === "booked") return booking.eventId || booking.appointmentId
    ? { status: "confirmed", source: "system", verified: true } : { status: "pending_confirmation", source: "system", verified: true };
  if (status === "awaiting_details") return { status: booking.selectedSlot ? "selected" : "suggested", source: "system", verified: true };
  if (BOOKING_STATUS_MAP[status]) return { status: BOOKING_STATUS_MAP[status], source: "system", verified: true };
  const bookingTool = [...toolResults].reverse().find((result) => ["requestBookingAction", "holdOrBookAppointment"].includes(result.tool) && result.ok === true);
  if (bookingTool?.status === "confirmed") return { status: "confirmed", source: "tool", verified: true };
  if (bookingTool && ["pending", "pending_review"].includes(bookingTool.status)) return { status: "pending_confirmation", source: "tool", verified: true };
  return { status: "none", source: "system", verified: true };
}

// ---------------------------------------------------------------- session
function sessionTurnsFrom(history = [], { now = Date.now(), idleTtlMs = 7_200_000 } = {}) {
  const list = Array.isArray(history) ? history : [];
  const session = [];
  let newer = now;
  for (let index = list.length - 1; index >= 0 && session.length < LIMITS.sessionTurns; index -= 1) {
    const at = Date.parse(list[index]?.at || "");
    if (Number.isFinite(at) && newer - at > idleTtlMs) break;
    session.unshift(list[index]);
    if (Number.isFinite(at)) newer = at;
  }
  return session;
}

/**
 * Builds the structured session state. Pure: no I/O, no model call.
 *   history         persisted turns BEFORE the current one
 *   currentMessage  the current customer message (already persisted as a turn)
 *   currentTurn     { id, at, intents, handoverRequested, handoverPersisted, specialistRequested }
 *   overlay         Map(turnId -> live outcome) from createSessionMemoryStore
 *   profileMemory   durable profile (userProfileMemory.readProfileMemory) or null
 */
function buildSessionMemory({ history = [], currentMessage = "", currentTurn = {}, language = "unknown", user = {}, overlay = new Map(),
  profileMemory = null, evidenceReuse = null, now = Date.now(), idleTtlMs = 7_200_000 } = {}) {
  const nowIso = new Date(now).toISOString();
  const sessionTurns = sessionTurnsFrom(history, { now, idleTtlMs });
  const overlayByTurn = overlay instanceof Map ? overlay : new Map();
  const nameFold = foldConfirmedName(history, { currentMessage, now });
  const state = {
    version: 1,
    startedAt: sessionTurns[0]?.at || nowIso, lastActivityAt: nowIso, turnCount: sessionTurns.length + 1,
    newSession: sessionTurns.length === 0,
    user: { name: nameFold.name, nameCorrections: nameFold.corrected, forgotten: nameFold.forgotten,
      language: { current: ["arabic", "english", "greek"].includes(language) ? language : "unknown", preferred: null },
      country: null, customerType: null, channelPreference: null },
    conversation: { currentTopic: businessIntents(currentTurn.intents).map(intentLabel).slice(0, 3), interests: [], requirements: [], tentative: [],
      corrections: [], openQuestions: [], askedQuestions: [], answersGiven: [], clarificationStreak: 0, recapRequested: false, forgetRequested: false },
    evidence: { reusableRefs: evidenceReuse?.status === "hit" ? (evidenceReuse.chunkIds || []).slice(0, 12) : [], reuseStatus: evidenceReuse?.status || "disabled",
      lastSuccessfulSearch: null },
    actions: { handoff: null, booking: null, toolResults: [], leadSaved: false }
  };
  if (nameFold.forgotten) state.conversation.corrections.push(item("forget", "customer asked to forget personal details", "corrected", "user", nowIso));

  const customerTurns = [...sessionTurns.map((turn) => ({ text: turn?.message || turn?.text || "", at: turn?.at || null, id: turn?.id || null, intents: turn?.metadata?.intent?.intents || [] })),
    { text: String(currentMessage || ""), at: nowIso, id: currentTurn.id || "current", intents: currentTurn.intents || [] }];
  let forgetIndex = -1;
  customerTurns.forEach((turn, index) => { if (isForgetRequest(turn.text)) forgetIndex = index; });

  customerTurns.forEach((turn, index) => {
    for (const intent of businessIntents(turn.intents)) {
      const label = intentLabel(intent);
      state.conversation.interests = state.conversation.interests.filter((entry) => entry.value !== label);
      state.conversation.interests.push(item("interest", label, "inferred", "system", turn.at, turn.id));
    }
    if (index <= forgetIndex) return; // personal details before "forget me" are not carried
    const signals = extractCustomerSignals(turn.text);
    if (signals.downgrade) {
      // Downgrade the confirmed requirement(s) the customer named. With no
      // specific words ("that was just an idea") it refers to the latest one.
      // With specific words that match no confirmed item (already tentative,
      // or another language), nothing confirmed is touched; the customer's
      // statement is kept as a correction note so it is not lost.
      const words = new Set(matchForm(turn.text).toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4
        && !/^(?:that|this|just|idea|only|actually|decided|confirmed|final|sure|maybe|really|thought|option|فكرة|مجرد|كانت|هيدا|هاد|مؤكد|نهائي|قررنا|اقتراح|احتمال)$/u.test(word)));
      const named = state.conversation.requirements.filter((requirement) => matchForm(requirement.value).toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => words.has(word)));
      const targets = named.length ? named : !words.size ? state.conversation.requirements.slice(-1) : [];
      if (!targets.length && words.size) state.conversation.corrections.push(item("note", clip(turn.text, 100), "corrected", "user", turn.at, turn.id));
      for (const requirement of targets) {
        state.conversation.corrections.push(item("requirement", requirement.value, "corrected", "user", turn.at, turn.id));
        state.conversation.tentative.push({ ...requirement, status: "tentative", updatedAt: turn.at || nowIso, turnId: turn.id });
      }
      state.conversation.requirements = state.conversation.requirements.filter((requirement) => !targets.includes(requirement));
    }
    for (const requirement of signals.requirements) {
      const target = requirement.tentative ? state.conversation.tentative : state.conversation.requirements;
      if (state.conversation.requirements.some((entry) => entry.value === requirement.value) || state.conversation.tentative.some((entry) => entry.value === requirement.value)) continue;
      target.push(item("requirement", requirement.value, requirement.tentative ? "tentative" : "confirmed", "user", turn.at, turn.id));
    }
    if (signals.country) {
      const previous = state.user.country;
      const next = item("country", signals.country.value, signals.country.tentative ? "tentative" : "confirmed", "user", turn.at, turn.id);
      next.qualifier = signals.country.qualifier;
      if (previous && previous.value !== next.value && previous.status === "confirmed" && next.status === "confirmed") {
        state.conversation.corrections.push(item("country", previous.value, "corrected", "user", turn.at, turn.id));
      }
      if (!(previous?.status === "confirmed" && next.status === "tentative")) state.user.country = next;
    }
    if (signals.preferredLanguage) state.user.language.preferred = item("preferred_language", signals.preferredLanguage.value, signals.preferredLanguage.tentative ? "tentative" : "confirmed", "user", turn.at, turn.id);
    if (signals.customerType) state.user.customerType = item("customer_type", signals.customerType.value, signals.customerType.tentative ? "tentative" : "confirmed", "user", turn.at, turn.id);
    if (signals.channelPreference) state.user.channelPreference = item("channel_preference", signals.channelPreference.value, signals.channelPreference.tentative ? "tentative" : "confirmed", "user", turn.at, turn.id);
  });
  state.conversation.requirements = state.conversation.requirements.slice(-LIMITS.requirements);
  state.conversation.tentative = state.conversation.tentative.slice(-LIMITS.tentative);
  state.conversation.interests = state.conversation.interests.slice(-LIMITS.interests);
  for (const correction of nameFold.corrected) state.conversation.corrections.push(item("name", correction.value, "corrected", "user", correction.at, correction.turnId));
  state.conversation.corrections = state.conversation.corrections.slice(-LIMITS.corrections);
  const current = customerTurns.at(-1);
  state.conversation.recapRequested = isRecapRequest(current.text);
  state.conversation.forgetRequested = isForgetRequest(current.text);

  // Questions the assistant already asked, and whether the customer replied.
  sessionTurns.forEach((turn, index) => {
    const question = deriveOpenQuestion(turn);
    if (!question) return;
    const answered = index < sessionTurns.length - 1 || Boolean(String(currentMessage || "").trim());
    const text = clip(question, 160);
    state.conversation.askedQuestions = state.conversation.askedQuestions.filter((entry) => normalizedQuestion(entry.text) !== normalizedQuestion(text));
    state.conversation.askedQuestions.push({ text, turnId: turn.id || null, answered });
  });
  state.conversation.askedQuestions = state.conversation.askedQuestions.slice(-LIMITS.askedQuestions);

  // Live overlay: outcomes, evidence refs, tools, clarifications, open questions.
  const toolResults = [];
  for (const turn of sessionTurns) {
    const overlayEntry = overlayByTurn.get(turn?.id);
    if (!overlayEntry) continue;
    if (overlayEntry.clarified) state.conversation.clarificationStreak += 1; else state.conversation.clarificationStreak = 0;
    if (overlayEntry.answered) {
      state.conversation.answersGiven.push({ turnId: turn.id, topics: (overlayEntry.topics || []).slice(0, 3), evidenceRefs: (overlayEntry.evidenceRefs || []).slice(0, 4), at: turn.at || null });
      state.conversation.openQuestions = state.conversation.openQuestions.filter((open) => !(overlayEntry.evidenceRefs || []).length
        || !open.topics.some((topic) => (overlayEntry.topics || []).includes(topic)));
    } else if (overlayEntry.unanswered && (overlayEntry.topics || []).length) {
      state.conversation.openQuestions.push({ topics: overlayEntry.topics.slice(0, 3), turnId: turn.id, reason: overlayEntry.unansweredReason || "not_confirmed", status: "unknown", source: "system" });
    }
    if (overlayEntry.search) state.evidence.lastSuccessfulSearch = { turnId: turn.id, at: turn.at || null, itemCount: overlayEntry.search.itemCount || 0 };
    for (const result of overlayEntry.toolResults || []) toolResults.push(result);
  }
  state.conversation.answersGiven = state.conversation.answersGiven.slice(-LIMITS.answersGiven);
  state.conversation.openQuestions = state.conversation.openQuestions.slice(-LIMITS.openQuestions);
  state.actions.toolResults = toolResults.slice(-LIMITS.toolResults);
  state.actions.leadSaved = toolResults.some((result) => result.tool === "upsertLead" && result.ok === true && result.status === "confirmed");
  state.actions.handoff = deriveHandoffState({ user, sessionTurns, overlayByTurn, currentTurn: { ...currentTurn, at: nowIso } });
  state.actions.booking = deriveBookingState({ user, toolResults });

  // Durable profile seeds only what this session has not established, and
  // never a value the customer corrected or asked us to forget.
  if (profileMemory && !nameFold.forgotten && !state.conversation.forgetRequested) {
    const fields = profileMemory.fields || {};
    const rejected = (value) => nameFold.corrected.some((entry) => sameName(entry.value, value));
    if (!state.user.name && fields.name?.value && !rejected(fields.name.value)) state.user.name = { ...fields.name, origin: "profile" };
    if (!state.user.language.preferred && fields.preferredLanguage?.value) state.user.language.preferred = { ...fields.preferredLanguage, origin: "profile" };
    if (!state.user.customerType && fields.customerType?.value) state.user.customerType = { ...fields.customerType, origin: "profile" };
    if (!state.user.channelPreference && Array.isArray(fields.longTermPreferences) && fields.longTermPreferences[0]) state.user.channelPreference = { ...fields.longTermPreferences[0], origin: "profile" };
    if (!state.conversation.interests.length && Array.isArray(fields.serviceInterest)) {
      state.conversation.interests = fields.serviceInterest.slice(-2).map((entry) => ({ ...entry, origin: "profile" }));
    }
  }
  if (state.conversation.forgetRequested) state.user.name = null;
  return state;
}

/** Facts the never-re-ask check can trust, derived from confirmed session items. */
function sessionKnownFacts(state) {
  const facts = {};
  if (state?.user?.country?.status === "confirmed" && state.user.country.qualifier === "residence") {
    facts.countryOfResidence = { value: state.user.country.value, provenance: "customer_message", confidence: 1 };
  }
  return facts;
}

// ---------------------------------------------------------------- rendering
const sizeOf = (text) => Buffer.byteLength(JSON.stringify(String(text || "")), "utf8") - 2;

const HANDOFF_WORDING = Object.freeze({
  not_requested: "none requested; nobody on the team has been contacted",
  requested: "customer asked for it but it is NOT submitted to the team yet; say it is not connected yet",
  submitted: "submitted to the team for review (system confirmed); nobody has replied or joined and no reply time is confirmed",
  queued: "submitted and a team notification is queued; nobody has replied or joined and no reply time is confirmed",
  accepted: "the team accepted it; nobody has joined this chat yet",
  human_joined: "a team member has joined this conversation",
  completed: "completed by the team",
  failed: "could not be submitted; never say it was sent; offer to try again"
});
const BOOKING_WORDING = Object.freeze({
  none: "none; nothing is booked, reserved or pending",
  suggested: "only suggested; nothing is reserved",
  selected: "slot chosen but not submitted; not confirmed",
  pending_confirmation: "request pending team review; never call it confirmed",
  confirmed: "confirmed by the booking system",
  cancelled: "cancelled",
  failed: "the booking attempt failed; nothing is booked"
});

function tag(entry) {
  if (!entry) return "";
  const origin = entry.origin === "profile" ? ",earlier conversation" : "";
  return `[${entry.status},${entry.source}${origin}]`;
}

/**
 * Renders the compact customer-context block. Lines are added by priority and
 * the lowest-priority lines are dropped first until the block fits maxBytes
 * (measured the same way as the decision prompt sizes). Returns the text and
 * its measured size; an empty string when nothing useful is known.
 */
function renderSessionStateBlock(state, { maxBytes = 1500, currentOpenQuestion = null, truthfulActions = true } = {}) {
  if (!state || maxBytes <= 0) return { text: "", bytes: 0, droppedLines: 0 };
  const lines = [];
  const add = (priority, text) => { if (text) lines.push({ priority, text }); };
  const user = state.user || {};
  const conv = state.conversation || {};
  add(0, user.name?.status === "confirmed" ? `name: ${clip(user.name.value, 60)} ${tag(user.name)}`
    : user.name?.status === "tentative" ? `name: unconfirmed (do not use)` : "name: not given (never guess one or use a WhatsApp/profile label)");
  // Only names the customer explicitly rejected are "wrong". A name replaced
  // by a newer one (possibly the same name in another script) is superseded.
  const wrongNames = (user.nameCorrections || []).filter((entry) => entry.reason === "rejected").map((entry) => `"${clip(entry.value, 40)}"`);
  if (wrongNames.length) add(0, `corrected name values (wrong, never use): ${wrongNames.slice(-3).join(", ")}`);
  if (conv.forgetRequested || user.forgotten) add(0, "customer asked to forget their personal details: do not use their name or earlier personal details; confirm briefly without describing storage");
  if (truthfulActions && state.actions) {
    add(0, `handoff: ${state.actions.handoff?.status || "not_requested"} (${HANDOFF_WORDING[state.actions.handoff?.status || "not_requested"]})`);
    add(0, `booking: ${state.actions.booking?.status || "none"} (${BOOKING_WORDING[state.actions.booking?.status || "none"]})`);
    add(1, state.actions.leadSaved ? "records: customer details saved this session (system confirmed); no ticket or CRM case exists"
      : "records: nothing is saved, filed, ticketed or logged by this chat");
  }
  if (conv.recapRequested) add(1, "recap requested: list Confirmed, Tentative, Open and Corrected points separately using these lines; restate company facts only from current evidence");
  if (conv.clarificationStreak >= 1) add(1, "one clarifying question was already asked: do not ask another; give the best safe answer or offer the real next step");
  const langParts = [`current=${user.language?.current || "unknown"}`];
  if (user.language?.preferred) langParts.push(`preferred=${user.language.preferred.value} ${tag(user.language.preferred)}`);
  add(2, `language: ${langParts.join("; ")}`);
  for (const entry of (conv.requirements || []).slice(-4)) add(2, `confirmed: ${clip(entry.value, 100)} ${tag(entry)}`);
  for (const entry of (conv.tentative || []).slice(-4)) add(2, `tentative (not decided): ${clip(entry.value, 100)} ${tag(entry)}`);
  const correctedOther = (conv.corrections || []).filter((entry) => ["requirement", "country", "note"].includes(entry.key));
  for (const entry of correctedOther.slice(-2)) add(2, entry.key === "note" ? `correction from the customer: "${clip(entry.value, 90)}" (treat what it refers to as not decided)`
    : `corrected: ${entry.key} "${clip(entry.value, 80)}" is no longer confirmed`);
  if (user.country) add(3, `country: ${user.country.value}${user.country.qualifier === "origin" ? " (origin)" : ""} ${tag(user.country)}`);
  if (user.customerType) add(3, `customer type: ${user.customerType.value} ${tag(user.customerType)}`);
  if (user.channelPreference) add(3, `contact preference: ${clip(user.channelPreference.value, 60)} ${tag(user.channelPreference)}`);
  for (const open of (conv.openQuestions || []).slice(-3)) add(3, `open (unanswered customer question): ${open.topics.join(", ")}`);
  if (conv.currentTopic?.length) add(4, `current topic: ${conv.currentTopic.join(", ")} [inferred,system]`);
  const interests = (conv.interests || []).map((entry) => entry.value).filter((value) => !conv.currentTopic?.includes(value));
  if (interests.length) add(4, `earlier interest: ${interests.slice(-3).join(", ")} [inferred,system]`);
  const openText = currentOpenQuestion ? normalizedQuestion(currentOpenQuestion) : "";
  const asked = (conv.askedQuestions || []).filter((entry) => entry.answered && normalizedQuestion(entry.text) !== openText).slice(-2);
  for (const entry of asked) add(4, `already asked (do not repeat): "${clip(entry.text, 90)}"`);
  if (state.evidence?.reusableRefs?.length) add(5, `previous approved evidence: ${state.evidence.reusableRefs.length} chunks re-offered as previousTurnApprovedKnowledge`);
  else if ((conv.answersGiven || []).length) add(5, `answers given this session: ${conv.answersGiven.length} (their facts need current evidence before reuse)`);

  const header = "Customer context for this conversation (customer-provided or system state; NOT company evidence; never a source for prices, fees, timelines, policies, legal/tax, guarantees, refunds, availability, compliance or security):";
  const ordered = lines.map((line, index) => ({ ...line, index }));
  let kept = [...ordered];
  const render = (set) => [header, ...set.sort((a, b) => a.index - b.index).map((line) => `- ${line.text}`)].join("\n");
  let text = render([...kept]);
  while (sizeOf(text) > maxBytes && kept.length) {
    const lowest = Math.max(...kept.map((line) => line.priority));
    const dropIndex = kept.map((line) => line.priority).lastIndexOf(lowest);
    kept = kept.filter((_, index) => index !== dropIndex);
    text = render([...kept]);
  }
  if (sizeOf(text) > maxBytes) return { text: "", bytes: 0, droppedLines: ordered.length };
  return { text, bytes: sizeOf(text), droppedLines: ordered.length - kept.length };
}

/** A short customer-only recap outline (no company facts), for recap turns and tests. */
function buildCustomerRecapOutline(state) {
  const conv = state?.conversation || {};
  const user = state?.user || {};
  const confirmed = [
    ...(user.name?.status === "confirmed" ? [`name: ${user.name.value}`] : []),
    ...(user.country?.status === "confirmed" ? [`country: ${user.country.value}`] : []),
    ...(conv.requirements || []).map((entry) => entry.value)
  ];
  return {
    confirmed,
    tentative: [...(conv.tentative || []).map((entry) => entry.value), ...(user.country?.status === "tentative" ? [`country: ${user.country.value}`] : [])],
    open: (conv.openQuestions || []).map((entry) => entry.topics.join(", ")),
    corrected: (conv.corrections || []).filter((entry) => entry.key !== "forget").map((entry) => `${entry.key}: ${entry.value}`)
  };
}

// ---------------------------------------------------------------- follow-ups
const VAGUE_FOLLOWUP = /^(?:so\s*,?\s*)?(?:(?:can|could|would)\s+you\s+tell\s+me\s+more|tell\s+me\s+more|(?:is\s+there\s+)?anything\s+else(?:\s+(?:i|we)\s+can\s+(?:help|do)(?:\s+(?:you\s+)?with)?)?(?:\s+you(?:'d|\s+would)\s+like(?:\s+to\s+(?:know|ask))?)?|do\s+you\s+have\s+any\s+(?:other|more|further)\s+questions|any\s+(?:other|more|further)\s+questions|how\s+(?:else\s+)?can\s+i\s+help(?:\s+you)?(?:\s+further)?|what\s+else(?:\s+can\s+i\s+(?:help|do))?(?:\s+(?:you\s+)?with)?|would\s+you\s+like\s+to\s+know\s+more|can\s+you\s+(?:give|share)\s+(?:me\s+)?more\s+(?:details|information))[\s\p{P}]*$|^(?:ممكن|بتقدر|تقدر|هل\s+يمكنك|هل\s+تستطيع)\s+(?:تخبرني|تقلي|تحكيلي|توضح(?:لي)?|تعطيني)\s+(?:أكثر|اكثر|أكتر|اكتر|تفاصيل\s+(?:أكثر|اكثر|أكتر))[\s\p{P}]*$|^(?:في|هل\s+(?:هناك|يوجد|في))\s+(?:شي|شيء|أي\s+شيء)\s+(?:تاني|ثاني|آخر|اخر)[^؟?]{0,30}[\s\p{P}]*$|^(?:هل\s+)?(?:لديك|عندك)\s+(?:أي\s+)?(?:أسئلة|اسئلة|استفسارات)\s+(?:أخرى|اخرى|تانية|ثانية)[\s\p{P}]*$|^(?:بتحب|بتحبي|هل\s+تود|هل\s+ترغب\s+(?:في|ب))\s+(?:تعرف|أن\s+تعرف|معرفة)\s+(?:أكثر|اكثر|أكتر|اكتر|المزيد)[\s\p{P}]*$|^(?:μπορείτε\s+να\s+μου\s+πείτε\s+περισσότερα|κάτι\s+άλλο|έχετε\s+(?:άλλες|κάποια\s+άλλη)\s+ερωτήσ\p{L}*|θα\s+θέλατε\s+να\s+μάθετε\s+περισσότερα)[\s\p{P}]*$/iu;
const NAME_QUESTION = /\bwhat(?:'s|\s+is)\s+your\s+name\b|\bmay\s+i\s+(?:know|have)\s+your\s+name\b|(?:ما|شو)\s+اسم(?:ك|\s+حضرتك)|πώς\s+σας\s+λένε/iu;

/**
 * RAFA_SMART_FOLLOWUPS. Removes a trailing generic question ("Anything
 * else?"), a question already asked and answered this session, or a question
 * for a detail the customer already confirmed. Deterministic, so no extra
 * model call; the answer itself is never removed, and if the question is the
 * whole reply it is left for the normal gates to judge.
 */
function stripUnhelpfulFollowups(text, state, { knownFacts = {} } = {}) {
  const sentences = splitSentences(text);
  const removed = [];
  if (sentences.length < 2) return { text, removed };
  const asked = (state?.conversation?.askedQuestions || []).filter((entry) => entry.answered);
  const facts = { ...sessionKnownFacts(state), ...(knownFacts || {}) };
  const kept = sentences.filter((sentence) => {
    if (!isQuestionText(sentence)) return true;
    const bare = sentence.replace(/^[\s\p{Extended_Pictographic}]+/u, "");
    if (VAGUE_FOLLOWUP.test(bare)) { removed.push("vague_question"); return false; }
    if (state?.user?.name?.status === "confirmed" && NAME_QUESTION.test(bare)) { removed.push("known_field:name"); return false; }
    const repeatedField = findRepeatedQuestion(bare, facts);
    if (repeatedField.length) { removed.push(`known_field:${repeatedField[0]}`); return false; }
    if (asked.some((entry) => tokenSimilarity(entry.text, bare) >= 0.8 && normalizedQuestion(bare).split(" ").length >= 3)) { removed.push("repeated_question"); return false; }
    return true;
  });
  if (!removed.length || !kept.length || kept.every(isQuestionText) && kept.length === 0) return { text, removed: [] };
  const result = kept.join(" ").trim();
  return result.length >= 12 ? { text: result, removed } : { text, removed: [] };
}

/**
 * RAFA_ANSWER_FIRST_STYLE. When the previous reply already opened with the
 * customer's name, drop the same vocative opener from this reply. Greeting,
 * introduction, correction and recap turns keep it (natural use).
 */
function dedupeLeadingName(text, { name, previousResponse = "", allowName = false } = {}) {
  if (!name || allowName) return { text, changed: false };
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const opener = new RegExp(`^\\s*(?:(?:أستاذ|أستاذة|استاذ|استاذة|Mr\\.?|Ms\\.?|Mrs\\.?|κύριε|κυρία)\\s+)?${escaped}\\s*[,،!:]\\s*`, "iu");
  if (!opener.test(String(previousResponse || "")) || !opener.test(String(text || ""))) return { text, changed: false };
  const stripped = String(text).replace(opener, "");
  if (stripped.length < 8) return { text, changed: false };
  return { text: stripped.charAt(0).toLocaleUpperCase() + stripped.slice(1), changed: true };
}

// ---------------------------------------------------------------- live overlay store
function createSessionMemoryStore({ maxSessions = 500, maxTurnsPerSession = 24, idleTtlMs = 7_200_000, now = Date.now } = {}) {
  const sessions = new Map();
  function prune() {
    const at = now();
    for (const [key, entry] of sessions) if (at - entry.lastActivityAt > idleTtlMs) sessions.delete(key);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
  }
  function overlay(sessionKey) {
    const entry = sessionKey ? sessions.get(sessionKey) : null;
    if (!entry) return new Map();
    if (now() - entry.lastActivityAt > idleTtlMs) { sessions.delete(sessionKey); return new Map(); }
    return new Map(entry.turns);
  }
  function recordTurn(sessionKey, turnId, outcome = {}) {
    if (!sessionKey || !turnId) return false;
    const entry = sessions.get(sessionKey) || { turns: new Map(), lastActivityAt: now() };
    entry.turns.set(turnId, {
      answered: outcome.answered === true, clarified: outcome.clarified === true, unanswered: outcome.unanswered === true,
      unansweredReason: typeof outcome.unansweredReason === "string" ? outcome.unansweredReason.slice(0, 40) : null,
      topics: (Array.isArray(outcome.topics) ? outcome.topics : []).filter((t) => typeof t === "string").slice(0, 3).map((t) => t.slice(0, 40)),
      evidenceRefs: (Array.isArray(outcome.evidenceRefs) ? outcome.evidenceRefs : []).filter((r) => typeof r === "string").slice(0, 6).map((r) => r.slice(0, 120)),
      search: outcome.search && Number.isFinite(outcome.search.itemCount) ? { itemCount: outcome.search.itemCount } : null,
      toolResults: (Array.isArray(outcome.toolResults) ? outcome.toolResults : []).slice(0, 4).map((r) => ({ tool: String(r.tool || "").slice(0, 40), ok: r.ok === true, status: String(r.status || "").slice(0, 30) })),
      handoffStatus: HANDOFF_STATES.includes(outcome.handoffStatus) ? outcome.handoffStatus : null
    });
    while (entry.turns.size > maxTurnsPerSession) entry.turns.delete(entry.turns.keys().next().value);
    entry.lastActivityAt = now();
    sessions.delete(sessionKey);
    sessions.set(sessionKey, entry);
    prune();
    return true;
  }
  return { overlay, recordTurn, forget: (sessionKey) => sessions.delete(sessionKey), clear: () => sessions.clear(), get size() { return sessions.size; } };
}

let processStore;
function getSessionMemoryStore({ idleTtlMs } = {}) {
  if (!processStore) processStore = createSessionMemoryStore(idleTtlMs ? { idleTtlMs } : {});
  return processStore;
}

module.exports = {
  STATUSES, SOURCES, HANDOFF_STATES, BOOKING_STATES, LIMITS,
  parseNameStatement, foldConfirmedName, isForgetRequest, isRecapRequest, isHedged, extractCustomerSignals,
  classifyUnansweredReason, buildSessionMemory, sessionTurnsFrom, sessionKnownFacts, deriveHandoffState, deriveBookingState,
  renderSessionStateBlock, buildCustomerRecapOutline, stripUnhelpfulFollowups, dedupeLeadingName,
  createSessionMemoryStore, getSessionMemoryStore, sizeOf, NEGATION, splitSentences, isQuestionText, sameName, containsWord, escapeRegExp
};
