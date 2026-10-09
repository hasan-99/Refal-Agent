const assert = require("node:assert/strict");
// Duplicated-enum guard, added at the M1 close. The same four humour levels are
// declared twice: here in the engine, and in src/brainGoldenSetSchema.js, which
// predates P1.3 and is consumed by the golden-set builders. They cannot share
// one definition without the engine depending on the evaluation schema, which
// is backwards. So they are pinned instead — the same remedy used for the
// ORDINARY budget, and for the same reason: two hand-synced copies of one
// constant is how BLK-4 happened.
const { test } = require("node:test");
const { INTENTS } = require("./intent");
const {
  HUMOUR_LEVELS, DEFAULT_LEVEL, HARD_BANS, EMOJI_ALLOWLIST,
  resolveHumourLevel, triggeredHardBans, humourDirective, assertHumourCompliance
} = require("./humourEngine");

// G2 requires >= 60 cases, with every hard ban proven in AR/EN/EL
// (3 cases x 6 bans x 3 languages = 54 minimum). The table below carries
// 3 phrasings per ban per language and is asserted case by case.
const BAN_CASES = {
  "MB-HB1": {
    english: [
      "My visa application was refused last week.",
      "They denied my residency permit and I need advice.",
      "My residence permit was revoked after I overstayed."
    ],
    arabic: [
      "رفضوا طلب الفيزا تبعي الأسبوع الماضي.",
      "تم رفض الإقامة وما بعرف شو أعمل.",
      "تأشيرتي ملغاة وبدي حل."
    ],
    greek: [
      "Η αίτηση για βίζα απορρίφθηκε.",
      "Μου ανακλήθηκε η άδεια παραμονής.",
      "Η διαμονή μου ακυρώθηκε και χρειάζομαι βοήθεια."
    ]
  },
  "MB-HB2": {
    english: [
      "We are in litigation with a former partner.",
      "There is a lawsuit pending against the company.",
      "The dispute went to arbitration last month."
    ],
    arabic: [
      "عنا دعوى قضائية مع شريك سابق.",
      "في قضية مرفوعة ضد الشركة.",
      "النزاع القانوني راح على تحكيم."
    ],
    greek: [
      "Είμαστε σε δικαστική διαμάχη με πρώην συνεργάτη.",
      "Υπάρχει αγωγή εναντίον της εταιρείας.",
      "Η υπόθεση πήγε σε διαιτησία."
    ]
  },
  "MB-HB3": {
    english: [
      "The company went bankrupt last year.",
      "I lost my savings in that deal.",
      "My account was frozen by the bank."
    ],
    arabic: [
      "الشركة أعلنت إفلاس السنة الماضية.",
      "خسرت كل مدخراتي بهالصفقة.",
      "الحساب مجمد من البنك."
    ],
    greek: [
      "Η εταιρεία οδηγήθηκε σε πτώχευση.",
      "Έχασα τις οικονομίες μου.",
      "Έγινε δέσμευση λογαριασμού από την τράπεζα."
    ]
  },
  "MB-HB4": {
    english: [
      "I want to file a complaint about your service.",
      "This is absolutely unacceptable and I am furious.",
      "I think this was a scam and I was misled."
    ],
    arabic: [
      "بدي أقدم شكوى على الخدمة.",
      "هذا غير مقبول أبداً وأنا غاضب.",
      "حاسس إنه نصب وضحكوا علينا."
    ],
    greek: [
      "Θέλω να κάνω παράπονο για την εξυπηρέτηση.",
      "Αυτό είναι απαράδεκτο και είμαι θυμωμένος.",
      "Νομίζω ότι ήταν απάτη."
    ]
  },
  "MB-HB5": {
    english: [
      "We received an AML investigation notice.",
      "The bank flagged it as suspicious activity.",
      "Are we affected by the sanctions list?"
    ],
    arabic: [
      "وصلنا إشعار تحقيق بخصوص غسل الأموال.",
      "البنك صنفه نشاط مشبوه.",
      "هل علينا عقوبات؟"
    ],
    greek: [
      "Λάβαμε ειδοποίηση για ξέπλυμα χρήματος.",
      "Η τράπεζα το χαρακτήρισε ύποπτη δραστηριότητα.",
      "Μας αφορούν οι κυρώσεις;"
    ]
  },
  "MB-HB6": {
    english: [
      "My father passed away last month.",
      "I am in hospital and cannot travel.",
      "The earthquake destroyed our office."
    ],
    arabic: [
      "والدي توفي الشهر الماضي.",
      "أنا بالمستشفى وما بقدر سافر.",
      "الزلزال دمر مكتبنا."
    ],
    greek: [
      "Ο πατέρας μου απεβίωσε τον περασμένο μήνα.",
      "Είμαι στο νοσοκομείο και δεν μπορώ να ταξιδέψω.",
      "Ο σεισμός κατέστρεψε το γραφείο μας."
    ]
  }
};

for (const [banId, byLanguage] of Object.entries(BAN_CASES)) {
  for (const [language, phrases] of Object.entries(byLanguage)) {
    for (const phrase of phrases) {
      test(`${banId} / ${language} forces humour level 0: ${phrase.slice(0, 38)}`, () => {
        const detected = triggeredHardBans(phrase);
        assert.ok(detected.some((ban) => ban.id === banId),
          `${banId} did not fire for ${language}: ${phrase}`);

        const resolved = resolveHumourLevel({ message: phrase, language });
        assert.equal(resolved.level, HUMOUR_LEVELS.SERIOUS, `level was not 0: ${phrase}`);
        assert.equal(resolved.reason, "hard_ban");
      });
    }
  }
}

test("the hard-ban table covers all six master-brain bans", () => {
  assert.equal(HARD_BANS.length, 6);
  assert.deepEqual(HARD_BANS.map((ban) => ban.id), ["MB-HB1", "MB-HB2", "MB-HB3", "MB-HB4", "MB-HB5", "MB-HB6"]);
  assert.deepEqual(Object.keys(BAN_CASES).sort(), HARD_BANS.map((ban) => ban.id).sort());
});

test("every non-Latin ban branch is reachable, not dead \\b-guarded code", () => {
  // \b is ASCII-only in JS. If a non-Latin branch were \b-wrapped it would never
  // match, and Arabic and Greek customers would get jokes during a bereavement
  // while English customers would not.
  for (const ban of HARD_BANS) {
    const arabic = BAN_CASES[ban.id].arabic[0];
    const greek = BAN_CASES[ban.id].greek[0];
    assert.ok(ban.other.test(arabic), `${ban.id} Arabic branch is unreachable`);
    assert.ok(ban.other.test(greek), `${ban.id} Greek branch is unreachable`);
  }
});

test("a hard ban is ABSOLUTE and cannot be lifted by a cheerful customer", () => {
  // This is the property that matters most. Jokes, emoji and a high lead tier
  // must not reintroduce humour next to a bereavement.
  const resolved = resolveHumourLevel({
    message: "haha my father passed away last month 😂😂 but anyway, about the company setup!",
    intents: [INTENTS.COMPANY_FORMATION],
    leadTier: "hnw",
    language: "english"
  });
  assert.equal(resolved.level, HUMOUR_LEVELS.SERIOUS);
  assert.equal(resolved.reason, "hard_ban");
  assert.ok(resolved.bans.includes("MB-HB6"));
});

test("a hard ban raised earlier in the conversation still applies on later turns", () => {
  const resolved = resolveHumourLevel({
    message: "So what does the package cost?",
    history: [{ message: "I want to complain, this was completely unacceptable." }],
    language: "english"
  });
  assert.equal(resolved.level, HUMOUR_LEVELS.SERIOUS);
  assert.ok(resolved.bans.includes("MB-HB4"));
});

test("the default level is 2 for ordinary commercial conversation", () => {
  const resolved = resolveHumourLevel({
    message: "Hi, can you tell me how to set up a company in Cyprus?",
    intents: [INTENTS.COMPANY_FORMATION],
    language: "english"
  });
  assert.equal(resolved.level, DEFAULT_LEVEL);
  assert.equal(resolved.level, HUMOUR_LEVELS.PLAYFUL);
  assert.equal(resolved.reason, "default");
});

test("a complaint intent alone forces level 0 even without ban wording", () => {
  const resolved = resolveHumourLevel({ message: "I need this looked at.", intents: [INTENTS.COMPLAINT] });
  assert.equal(resolved.level, HUMOUR_LEVELS.SERIOUS);
  assert.equal(resolved.reason, "intent");
});

test("sensitive and high-value contexts sit at level 1", () => {
  assert.equal(resolveHumourLevel({ message: "What is the VAT rate for a holding structure?" }).level, HUMOUR_LEVELS.WARM);
  assert.equal(resolveHumourLevel({ message: "Tell me about the tender.", intents: [INTENTS.CONSTRUCTION_TENDER] }).level, HUMOUR_LEVELS.WARM);
  assert.equal(resolveHumourLevel({ message: "Looking at options.", leadTier: "hot" }).level, HUMOUR_LEVELS.WARM);
});

test("level 3 is customer-led, never self-initiated", () => {
  assert.equal(resolveHumourLevel({ message: "haha ok, so what do you actually do?" }).level, HUMOUR_LEVELS.VERY_PLAYFUL);
  assert.equal(resolveHumourLevel({ message: "😄😄 tell me more" }).level, HUMOUR_LEVELS.VERY_PLAYFUL);
  // A neutral message must not reach level 3 on its own.
  assert.equal(resolveHumourLevel({ message: "Tell me more about your services." }).level, DEFAULT_LEVEL);
});

test("level directives are authored in all three languages", () => {
  for (const level of [0, 1, 2, 3]) {
    for (const language of ["english", "arabic", "greek"]) {
      const directive = humourDirective(level, language);
      assert.ok(directive && directive.length > 30, `level ${level} ${language} directive is too thin`);
    }
    assert.match(humourDirective(level, "arabic"), /[؀-ۿ]/u);
    assert.match(humourDirective(level, "greek"), /[Ͱ-Ͽ]/u);
  }
  assert.equal(humourDirective(2, "klingon"), humourDirective(2, "english"));
});

test("the emoji allowlist narrows as the level drops", () => {
  assert.deepEqual([...EMOJI_ALLOWLIST[0]], []);
  assert.deepEqual([...EMOJI_ALLOWLIST[1]], ["👍"]);
  assert.ok(EMOJI_ALLOWLIST[2].includes("😄"));
  assert.ok(EMOJI_ALLOWLIST[3].includes("😂"));
  // Every lower level's allowlist is a subset of the next one up.
  for (const level of [0, 1, 2]) {
    for (const emoji of EMOJI_ALLOWLIST[level]) {
      assert.ok(EMOJI_ALLOWLIST[level + 1].includes(emoji), `${emoji} missing from level ${level + 1}`);
    }
  }
});

test("the output gate strips disallowed emoji at level 0", () => {
  const result = assertHumourCompliance("I am sorry to hear that 😄👍", 0);
  assert.equal(result.ok, false);
  assert.equal(result.sanitized, "I am sorry to hear that");
  assert.ok(result.violations.some((violation) => violation.rule === "disallowed_emoji"));
});

test("the output gate REJECTS a joking construction rather than stripping it", () => {
  // A joke is load-bearing in its sentence; deleting the words leaves nonsense,
  // so the caller must regenerate instead of shipping sanitized text.
  const result = assertHumourCompliance("Your visa was refused, haha just kidding, let me check.", 0);
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.ok(result.violations.some((violation) => violation.rule === "joking_construction"));
});

test("the output gate rejects joking in Arabic and Greek too", () => {
  assert.equal(assertHumourCompliance("أمزح معك، بس الموضوع جدي.", 0).rejected, true);
  assert.equal(assertHumourCompliance("Πλάκα κάνω, αλλά σοβαρά τώρα.", 1).rejected, true);
});

test("the output gate passes compliant text untouched", () => {
  const clean = assertHumourCompliance("Happy to help with that 👍", 1);
  assert.equal(clean.ok, true);
  assert.equal(clean.rejected, false);
  assert.equal(clean.sanitized, "Happy to help with that 👍");

  const playful = assertHumourCompliance("Great question 😄", 2);
  assert.equal(playful.ok, true);
});

test("level 3 permits joking, level 1 does not", () => {
  assert.equal(assertHumourCompliance("haha, fair enough 😂", 3).ok, true);
  assert.equal(assertHumourCompliance("haha, fair enough 😂", 1).ok, false);
});

test("an empty or missing message never crashes the resolver", () => {
  assert.equal(resolveHumourLevel({}).level, DEFAULT_LEVEL);
  assert.equal(resolveHumourLevel({ message: "" }).level, DEFAULT_LEVEL);
  assert.equal(triggeredHardBans("").length, 0);
  assert.equal(triggeredHardBans(null).length, 0);
});

test("the humour level enum has not drifted from brainGoldenSetSchema's copy", () => {
  const schema = require("./brainGoldenSetSchema");
  assert.deepEqual(HUMOUR_LEVELS, schema.HUMOUR_LEVELS,
    "src/humourEngine.js and src/brainGoldenSetSchema.js declare the same four levels; they have diverged");
  // The default must also be a level the enum actually contains, or the
  // directive lookup silently falls through to English level 2.
  assert.ok(Object.values(HUMOUR_LEVELS).includes(DEFAULT_LEVEL));
});
