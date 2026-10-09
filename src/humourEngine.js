const { SAFETY_CATEGORIES, detectSafetyRisks } = require("./safetyPolicy");
const { INTENTS } = require("./intent");
const { LEAD_TIERS } = require("./leadTemperature");

// P1.3 — Humour Engine, levels 0 to 3 (removes BLK-7).
//
// The master brain treats humour as a calibrated instrument, not a personality
// setting: خفيفة دم بس فاهمة شغلها. Getting it wrong is not a tone problem, it is
// a trust problem — a joke landing next to a visa refusal or a bereavement does
// more damage than a dry answer ever could.
//
// Design rule that matters most: the hard bans are ABSOLUTE and are evaluated
// FIRST. Nothing — not a cheerful customer, not a positive history, not a high
// lead tier — can lift level 0 once a ban fires. Everything else is a default
// that can be adjusted.
//
// REGEX WARNING: JavaScript's \b is ASCII-only even under /u. Arabic and Greek
// letters are not \w, so a \b-wrapped non-Latin alternative is DEAD CODE that
// silently never matches. Every pattern below is therefore split into a Latin
// half (with \b) and a non-Latin half (without). This repo has shipped that bug
// twice already; here it would mean Arabic and Greek customers getting jokes
// during a bereavement while English customers do not.

const HUMOUR_LEVELS = Object.freeze({ SERIOUS: 0, WARM: 1, PLAYFUL: 2, VERY_PLAYFUL: 3 });
const DEFAULT_LEVEL = HUMOUR_LEVELS.PLAYFUL;

// MB-HB1..HB6. Each ban is a pair of patterns so the non-Latin half is reachable.
const HARD_BANS = Object.freeze([
  {
    id: "MB-HB1",
    label: "residency_or_visa_difficulty",
    latin: /\b(?:visa|residenc\w*|permit|application)\b[^.?!]{0,60}\b(?:refus\w*|reject\w*|denied|declin\w*|cancel\w*|revok\w*|expired|overstay\w*|deport\w*|appeal)\b|\b(?:refus\w*|reject\w*|denied|declin\w*|revok\w*|deport\w*)\b[^.?!]{0,60}\b(?:visa|residenc\w*|permit)\b/iu,
    // Arabic nouns take possessive suffixes (تأشيرتي = "my visa"), so these match
    // on the STEM. Matching the citation form تأشيرة would miss every customer
    // who writes about their own visa, which is almost all of them.
    other: /(?:رفض|مرفوض|رُفض|رفضت)[^.؟!]{0,60}(?:فيزا|تأشير|إقام|اقام|طلب)|(?:فيزا|تأشير|إقام|اقام)[^.؟!]{0,60}(?:رفض|مرفوض|ملغا|منتهي|ترحيل)|(?:απορρίφθηκε|απόρριψη|ανακλήθηκε|ακυρώθηκε|απέλαση)[^.;!]{0,60}(?:βίζα|άδεια|διαμονή)|(?:βίζα|άδεια παραμονής|διαμονή|αίτηση για βίζα)[^.;!]{0,60}(?:απορρίφθηκε|απόρριψη|ανακλήθηκε|ακυρώθηκε)/iu
  },
  {
    id: "MB-HB2",
    label: "legal_dispute_or_proceedings",
    latin: /\b(?:lawsuit|litigation|court|tribunal|sued|suing|subpoena|injunction|arbitration|legal action|dispute|prosecut\w*|judgment|judgement)\b/iu,
    other: /(?:دعوى|محكمة|قضية|مقاضاة|نزاع قانوني|تحكيم|حكم قضائي|مقاضا)|(?:δικαστήριο|αγωγή|μήνυση|δικαστικ\w*|διαιτησία|δικαστική διαμάχη)/iu
  },
  {
    id: "MB-HB3",
    label: "financial_loss_or_default",
    // "account was frozen" needs the gap: customers write it in the passive far
    // more often than as the adjective phrase "frozen account".
    latin: /\b(?:bankrupt\w*|insolven\w*|default\w*|foreclos\w*|repossess\w*|wrote off|write[- ]off|lost (?:my|our|the) (?:money|savings|investment|deposit)|financial loss|debt collect\w*)\b|\baccounts?\b[^.?!]{0,25}\b(?:frozen|freeze|blocked|seized|suspended)\b|\b(?:frozen|blocked|seized|suspended)\b[^.?!]{0,25}\baccounts?\b/iu,
    other: /(?:إفلاس|افلاس|تعثر|خسرت|خسرنا|خسارة مالية|حجز على|تجميد الحساب|الحساب مجمد|ديون متأخرة)|(?:πτώχευση|αφερεγγυότητα|χρεοκοπ\w*|έχασα|οικονομική ζημία|δέσμευση λογαριασμού|κατάσχεση)/iu
  },
  {
    id: "MB-HB4",
    label: "complaint_anger_dissatisfaction",
    latin: /\b(?:complaint|complain\w*|unacceptable|outrageous|disgust\w*|furious|angry|frustrat\w*|disappointed|dissatisf\w*|terrible service|poor service|waste of (?:my )?time|scam\w*|fraud\w*|mislead\w*|misled|lied to|rip[- ]?off)\b/iu,
    other: /(?:شكوى|أشتكي|اشتكي|غير مقبول|غاضب|زعلان|محبط|خيبة أمل|مستاء|خدمة سيئة|نصب|احتيال|ضحك علينا|كذب علي)|(?:παράπονο|καταγγελία|απαράδεκτο|θυμωμέν\w*|απογοητευ\w*|δυσαρεστ\w*|κακή εξυπηρέτηση|απάτη|εξαπάτηση)/iu
  },
  {
    id: "MB-HB5",
    label: "aml_kyc_sanctions",
    // "suspicious activity" on its own is the phrasing a bank actually uses to a
    // customer; requiring the full "suspicious activity report" missed it.
    latin: /\b(?:aml|kyc|sanction\w*|embargo|money launder\w*|terror\w* financ\w*|pep screening|politically exposed|compliance investigation|suspicious activity|freezing order)\b/iu,
    other: /(?:غسل الأموال|غسيل الأموال|تمويل الإرهاب|عقوبات|حظر|العناية الواجبة|تحقيق امتثال|نشاط مشبوه)|(?:ξέπλυμα (?:χρήματος|βρώμικου)|χρηματοδότηση τρομοκρατίας|κυρώσεις|εμπάργκο|ύποπτη δραστηριότητα)/iu
  },
  {
    id: "MB-HB6",
    label: "illness_death_force_majeure",
    latin: /\b(?:passed away|died|death|funeral|bereave\w*|terminal\w*|cancer|hospital\w*|intensive care|seriously ill|critical condition|stroke|heart attack|earthquake|flood|wildfire|war|evacuat\w*|force majeure)\b/iu,
    other: /(?:توفي|توفى|وفاة|متوفي|جنازة|عزاء|مرض خطير|مريض جدا|سرطان|مستشفى|العناية المركزة|جلطة|زلزال|فيضان|حرب|إجلاء|قوة قاهرة)|(?:απεβίωσε|θάνατος|κηδεία|πένθος|σοβαρά άρρωστ\w*|καρκίνος|νοσοκομείο|εντατική|εγκεφαλικό|έμφραγμα|σεισμός|πλημμύρα|πόλεμος|ανωτέρα βία)/iu
  }
]);

// Safety categories that independently force seriousness, per the P1.3 table
// ("sensitive legal, sanctions/AML" at level 0).
const LEVEL_0_RISKS = Object.freeze([SAFETY_CATEGORIES.LEGAL]);

// "complex tax, HNW investors, major structures" sit at level 1.
const LEVEL_1_RISKS = Object.freeze([
  SAFETY_CATEGORIES.TAX, SAFETY_CATEGORIES.BANKING, SAFETY_CATEGORIES.IMMIGRATION,
  SAFETY_CATEGORIES.PERMIT, SAFETY_CATEGORIES.APPROVAL, SAFETY_CATEGORIES.INVESTMENT,
  SAFETY_CATEGORIES.PRIVACY
]);

const LEVEL_1_INTENTS = Object.freeze([
  INTENTS.CONSTRUCTION_TENDER, INTENTS.INVESTMENT_PARTNERSHIP, INTENTS.STRATEGIC_PARTNERSHIP,
  INTENTS.PROPERTY_DEVELOPMENT, INTENTS.INFRASTRUCTURE
]);

const LEVEL_0_INTENTS = Object.freeze([INTENTS.COMPLAINT]);

// W1.3.5 — emoji allowlist per level. Level 0 permits none at all.
const EMOJI_ALLOWLIST = Object.freeze({
  0: Object.freeze([]),
  1: Object.freeze(["👍"]),
  2: Object.freeze(["😄", "👀", "👍"]),
  3: Object.freeze(["😄", "👀", "👍", "😂", "🙌", "✨"])
});

// Matches emoji broadly so anything outside the allowlist is caught, including
// pictographs the allowlist never anticipated.
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

// Joking constructions that must not survive at levels 0 and 1.
// 😂 deliberately does NOT belong in this \b-wrapped group: an emoji is not a
// word character, so the alternative would be unreachable. Emoji are policed by
// the allowlist in assertHumourCompliance instead, which is the right mechanism.
const JOKING_LATIN = /\b(?:just kidding|just joking|kidding|lol|haha+|hehe+|no pun intended|pun intended|jokes aside)\b/iu;
const JOKING_OTHER = /(?:أمزح|امزح|مزحة|على فكرة مزحة|هههه|ههه)|(?:πλάκα κάνω|αστειεύομαι|χαχα+)/iu;

function triggeredHardBans(text) {
  const value = String(text || "");
  if (!value.trim()) return [];
  return HARD_BANS.filter((ban) => ban.latin.test(value) || ban.other.test(value));
}

/**
 * W1.3.1 / W1.3.2 — resolve the humour level for a turn.
 *
 * Order is deliberate and must not be rearranged: hard bans are checked before
 * anything that could raise the level, so no amount of customer cheerfulness can
 * reintroduce humour into a bereavement or a visa refusal.
 */
function resolveHumourLevel({
  message = "", history = [], intents = [], safetyRisks = null, leadTier = "", language = "english"
} = {}) {
  const historyText = (Array.isArray(history) ? history : [])
    .map((turn) => (typeof turn === "string" ? turn : turn?.message || turn?.content || ""))
    .join("\n");
  // The ban looks at the whole conversation, not just this turn: a customer who
  // reported a bereavement two turns ago is still bereaved.
  const scanned = `${message}\n${historyText}`;

  const bans = triggeredHardBans(scanned);
  if (bans.length) {
    return { level: HUMOUR_LEVELS.SERIOUS, reason: "hard_ban", bans: bans.map((ban) => ban.id), language };
  }

  const activeIntents = Array.isArray(intents) ? intents : [intents];
  if (activeIntents.some((intent) => LEVEL_0_INTENTS.includes(intent))) {
    return { level: HUMOUR_LEVELS.SERIOUS, reason: "intent", bans: [], language };
  }

  const risks = Array.isArray(safetyRisks) ? safetyRisks : detectSafetyRisks(message);
  if (risks.some((risk) => LEVEL_0_RISKS.includes(risk))) {
    return { level: HUMOUR_LEVELS.SERIOUS, reason: "safety_risk", bans: [], language };
  }
  // A HOT lead is a serious commercial moment (an appointment booked or being
  // booked), so it warrants warmth rather than playfulness. The plan's table
  // names "HNW investors" here, but wealth is not something this system
  // classifies; `hot` is the real signal it emits, so that is what is used.
  if (risks.some((risk) => LEVEL_1_RISKS.includes(risk))
      || activeIntents.some((intent) => LEVEL_1_INTENTS.includes(intent))
      || String(leadTier).toLowerCase() === LEAD_TIERS.HOT) {
    return { level: HUMOUR_LEVELS.WARM, reason: "sensitive_or_high_value", bans: [], language };
  }

  // Level 3 only when the customer themselves set a playful tone.
  if (JOKING_LATIN.test(message) || JOKING_OTHER.test(message) || countEmoji(message) >= 2) {
    return { level: HUMOUR_LEVELS.VERY_PLAYFUL, reason: "customer_led", bans: [], language };
  }

  return { level: DEFAULT_LEVEL, reason: "default", bans: [], language };
}

function countEmoji(text) {
  return (String(text || "").match(EMOJI_PATTERN) || []).length;
}

// W1.3.3 — level directives, authored natively per language rather than
// translated, so the instruction reads naturally to the model in each one.
const LEVEL_DIRECTIVES = Object.freeze({
  0: {
    english: "Be sober and direct. No humour of any kind, no playful emoji, no lightness. Acknowledge the seriousness plainly and answer.",
    arabic: "كوني جدية ومباشرة. بدون أي مزاح أو إيموجي أو خفة. اعترفي بجدية الموقف بوضوح وجاوبي.",
    greek: "Να είσαι σοβαρή και άμεση. Κανένα χιούμορ, κανένα παιχνιδιάρικο emoji, καμία ελαφρότητα. Αναγνώρισε τη σοβαρότητα και απάντησε."
  },
  1: {
    english: "Stay professional, calm and positive. No spontaneous jokes and never joke about budgets. 👍 is the only emoji permitted.",
    arabic: "حافظي على أسلوب مهني وهادئ وإيجابي. بدون نكت عفوية وممنوع المزاح حول الميزانية. 👍 هو الإيموجي الوحيد المسموح.",
    greek: "Μείνε επαγγελματική, ήρεμη και θετική. Χωρίς αυθόρμητα αστεία και ποτέ αστεία για προϋπολογισμούς. Μόνο το 👍 επιτρέπεται."
  },
  2: {
    english: "Be smart, simple and light-hearted. A light touch is welcome where it fits. Never belittle a question and never over-joke. Permitted emoji: 😄 👀 👍",
    arabic: "كوني ذكية وبسيطة وخفيفة الظل. الخفة مرحب فيها لما تناسب. ما تقللي أبداً من قيمة أي سؤال وما تكثري المزاح. الإيموجي المسموح: 😄 👀 👍",
    greek: "Να είσαι έξυπνη, απλή και ανάλαφρη. Μια ελαφριά πινελιά είναι ευπρόσδεκτη όπου ταιριάζει. Ποτέ μην υποτιμήσεις μια ερώτηση και μην το παρακάνεις. Επιτρεπόμενα emoji: 😄 👀 👍"
  },
  3: {
    english: "Match the customer's playful tone with quick wit. Never break their dignity, and never make a promise inside a joke.",
    arabic: "جاري العميل بروحه المرحة وبخفة دم وسرعة بديهة. ما تمسي أبداً بكرامته، وما تعطي أي وعد داخل مزحة.",
    greek: "Ακολούθησε το παιχνιδιάρικο ύφος του πελάτη με ετοιμολογία. Ποτέ μην θίξεις την αξιοπρέπειά του και ποτέ μην δώσεις υπόσχεση μέσα σε αστείο."
  }
});

function humourDirective(level, language = "english") {
  const block = LEVEL_DIRECTIVES[level] || LEVEL_DIRECTIVES[DEFAULT_LEVEL];
  return block[language] || block.english;
}

/**
 * W1.3.4 — output gate. Runs beside validateResponse.
 *
 * Levels 0 and 1 REJECT a joking construction rather than silently stripping it,
 * because a joke is usually load-bearing in its sentence and removing the words
 * leaves nonsense. Disallowed emoji are stripped, since removing them leaves the
 * sentence intact.
 */
function assertHumourCompliance(answer, level = DEFAULT_LEVEL) {
  const text = String(answer || "");
  const allowed = new Set(EMOJI_ALLOWLIST[level] || EMOJI_ALLOWLIST[DEFAULT_LEVEL]);
  const violations = [];

  if (level <= HUMOUR_LEVELS.WARM && (JOKING_LATIN.test(text) || JOKING_OTHER.test(text))) {
    violations.push({ rule: "joking_construction", level });
  }

  const disallowed = [...new Set((text.match(EMOJI_PATTERN) || []).filter((emoji) => !allowed.has(emoji)))];
  if (disallowed.length) violations.push({ rule: "disallowed_emoji", level, emoji: disallowed });

  let sanitized = text;
  if (disallowed.length) {
    sanitized = text.replace(EMOJI_PATTERN, (emoji) => (allowed.has(emoji) ? emoji : ""))
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/ +([.,!?;:؟])/gu, "$1")
      .trim();
  }

  return {
    ok: violations.length === 0,
    // A joking construction cannot be repaired by stripping characters, so the
    // caller must regenerate rather than ship the sanitized text.
    rejected: violations.some((violation) => violation.rule === "joking_construction"),
    violations,
    sanitized
  };
}

module.exports = {
  HUMOUR_LEVELS,
  DEFAULT_LEVEL,
  HARD_BANS,
  EMOJI_ALLOWLIST,
  LEVEL_DIRECTIVES,
  resolveHumourLevel,
  triggeredHardBans,
  humourDirective,
  assertHumourCompliance,
  countEmoji
};
