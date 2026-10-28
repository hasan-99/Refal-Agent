"use strict";

// Deterministic preflight for OBVIOUS social turns only (RAFA_FAST_SOCIAL_PATH).
//
// A message qualifies only when, after removing punctuation and emoji, nothing
// is left but a short greeting, thanks or goodbye phrase (Arabic, English,
// Greek), or when it is emoji-only. Anything else, including any question
// mark, digit, "ok"/"yes"/"تمام" (which can accept an offer) or extra words,
// goes to the normal LLM preflight. It is also skipped right after an
// assistant turn that carried a tracked specialist/reminder offer, so a
// reaction to an offer is always classified by the model.
//
// The result has the same shape as the model preflight with operation "none":
// it grants no consent, starts no workflow, and the agent still drafts the
// reply and the grounding reviewer still checks it.

const { INTENTS } = require("./intent");
const { detectMessageLanguage } = require("./language");

const LANGUAGES = new Set(["arabic", "english", "greek"]);
const MAX_SOCIAL_CHARS = 60;

const GREETING_PHRASES = [
  "hi", "hello", "hey", "hiya", "good morning", "good afternoon", "good evening", "morning",
  "مرحبا", "اهلا", "اهلين", "اهلا وسهلا", "هلا", "هاي", "هلو", "السلام عليكم", "سلام عليكم", "وعليكم السلام",
  "صباح الخير", "صباح النور", "مساء الخير", "مساء النور",
  "γεια", "γεια σου", "γεια σας", "καλημερα", "καλησπερα"
];
const THANKS_PHRASES = [
  "thanks", "thank you", "thank you so much", "thanks a lot", "many thanks", "thx", "ty", "cheers",
  "شكرا", "شكرا جزيلا", "شكرا كتير", "مشكور", "مشكورة", "مشكورين", "يعطيك العافية", "الله يعطيك العافية", "تسلم", "تسلمي", "ممنون", "ميرسي",
  "ευχαριστω", "ευχαριστω πολυ"
];
const GOODBYE_PHRASES = [
  "bye", "bye bye", "goodbye", "see you", "see ya", "take care", "good night", "have a nice day",
  "مع السلامة", "باي", "الله معك", "تصبح على خير", "تصبحي على خير",
  "αντιο", "καληνυχτα", "τα λεμε"
];

function fold(text) {
  return String(text || "").normalize("NFKD")
    // Greek tonos and Arabic harakat are combining marks after NFKD; Arabic
    // tatweel is decorative. None of these change which phrase was written.
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/gu, "")
    .normalize("NFKC")
    .replace(/[أإآ]/gu, "ا")
    .toLocaleLowerCase();
}

const phrasePattern = (phrases) => phrases.map(fold).sort((a, b) => b.length - a.length)
  .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+")).join("|");
const SOCIAL_SEQUENCE = new RegExp(`^(?:(?:${phrasePattern([...GREETING_PHRASES, ...THANKS_PHRASES, ...GOODBYE_PHRASES])})\\s*){1,3}$`, "u");
const GREETING_ONLY = new RegExp(`^(?:(?:${phrasePattern(GREETING_PHRASES)})\\s*){1,3}$`, "u");
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu;
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}/u;
const SOCIAL_PUNCTUATION = /[!.,،~\-–—:;؛…()"'«»]/gu;

function lastAssistantCarriedOffer(user) {
  const last = Array.isArray(user?.history) ? user.history.at(-1) : null;
  return Boolean(last?.metadata?.specialistOffer?.consentRequired === true
    || last?.metadata?.automatedReminderOffer?.purpose === "automated_reminder");
}

function fallbackLanguage(user) {
  const lastMessage = Array.isArray(user?.history) ? [...user.history].reverse().find((turn) => typeof turn?.message === "string" && turn.message.trim())?.message : null;
  const fromHistory = lastMessage ? detectMessageLanguage(lastMessage) : null;
  if (LANGUAGES.has(fromHistory)) return fromHistory;
  const profileLanguage = String(user?.profile?.language || "").toLowerCase();
  return LANGUAGES.has(profileLanguage) ? profileLanguage : "english";
}

/**
 * @returns {null | { intents: string[], primary: string, isMultiIntent: false, language: string,
 *   operation: "none", offerSourceTurnId: null, noProactiveBookingOrContact: false, source: string }}
 */
function obviousSocialClassification(message, user = {}) {
  const raw = String(message || "").trim();
  if (!raw || raw.length > MAX_SOCIAL_CHARS || /[?؟;\d٠-٩@#/\\]/u.test(raw)) return null;
  if (lastAssistantCarriedOffer(user)) return null;
  const words = fold(raw).replace(EMOJI, " ").replace(SOCIAL_PUNCTUATION, " ").replace(/\s+/gu, " ").trim();
  let intent;
  if (!words) {
    if (!HAS_PICTOGRAPH.test(raw)) return null;
    intent = INTENTS.SMALL_TALK;
  } else if (SOCIAL_SEQUENCE.test(words)) {
    intent = GREETING_ONLY.test(words) ? INTENTS.GREETING : INTENTS.SMALL_TALK;
  } else {
    return null;
  }
  const detected = words ? detectMessageLanguage(raw) : null;
  const language = LANGUAGES.has(detected) ? detected : fallbackLanguage(user);
  return Object.freeze({ intents: [intent], primary: intent, isMultiIntent: false, language, operation: "none",
    offerSourceTurnId: null, noProactiveBookingOrContact: false, source: "deterministic_social_fast_path" });
}

module.exports = { obviousSocialClassification };
