// MB-B1..B5 instant buying signals. This is an intent detector only: callers
// may raise qualification and offer the guarded booking flow, but this module
// never books, hands over, or represents an action as confirmed.
const SIGNALS = Object.freeze([
  { id: "MB-B1", scoreFloor: 20, action: "offer_booking", patterns: [
    /كيف\s+ابدأ\s+الاجراءات\s+معك/u, /how\s+(?:do\s+i|can\s+i)\s+start\s+(?:the\s+)?(?:process|procedures)\s+with\s+you/iu,
    /πως\s+ξεκιναω\s+τη\s+διαδικασια\s+μαζι\s+σας/iu, /keef\s+(?:balle?sh|ballesh)\s+el\s+ijra2at\s+ma3ak/iu,
    /pos\s+na\s+arxiso\s+ti\s+diadikasia\s+mazi\s+sas/iu
  ] },
  { id: "MB-B2", scoreFloor: 20, action: "offer_booking", patterns: [
    /شو\s+الاوراق\s+المطلوبة\s+مني\s+الان/u, /what\s+documents\s+do\s+you\s+need\s+from\s+me\s+now/iu,
    /ποια\s+εγγραφα\s+χρειαζεστε\s+απο\s+εμενα\s+τωρα/iu, /shu\s+el\s+awra2\s+el\s+matlube\s+minni\s+halla2/iu,
    /pia\s+engrafa\s+xreiazeste\s+apo\s+mena\s+tora/iu
  ] },
  { id: "MB-B3", scoreFloor: 20, action: "offer_booking", patterns: [
    /طريقة\s+الدفع\s+وكيف\s+باكد\s+الحجز/u, /payment\s+method\s+and\s+how\s+(?:do\s+i\s+)?confirm\s+the\s+booking/iu,
    /τροπος\s+πληρωμης\s+και\s+πως\s+επιβεβαιωνω\s+την\s+κρατηση/iu, /tari2et\s+ed\s+dafa3\s+we\s+keef\s+b2akked\s+el\s+7ajz/iu,
    /tropos\s+pliromis\s+kai\s+pos\s+epiveveono\s+tin\s+kratisi/iu
  ] },
  { id: "MB-B4", scoreFloor: 20, action: "offer_booking", patterns: [
    /ممكن\s+اكلم\s+المستشار\s+او\s+ازور\s+مكتبكم/u, /can\s+i\s+(?:speak\s+to|talk\s+to)\s+the\s+consultant\s+or\s+visit\s+your\s+office/iu,
    /μπορω\s+να\s+μιλησω\s+με\s+τον\s+συμβουλο\s+η\s+να\s+επισκεφτω\s+το\s+γραφειο\s+σας/iu,
    /momken\s+(?:e7ki|ehki)\s+ma3\s+el\s+mostashar\s+aw\s+(?:azur|زور)\s+makatabkom/iu,
    /boro\s+na\s+miliso\s+me\s+ton\s+symvoulo\s+i\s+na\s+episkeftho\s+to\s+grafeio\s+sas/iu
  ] },
  { id: "MB-B5", scoreFloor: 25, action: "priority_booking_escalation", patterns: [
    /عندي\s+ارض\s+للتطوير/u, /عندي\s+تمويل\s+جاهز\s+للمشروع/u,
    /i\s+have\s+(?:land\s+for\s+development|financing\s+ready\s+for\s+(?:the\s+)?project)/iu,
    /εχω\s+γη\s+για\s+αναπτυξη/iu, /εχω\s+ετοιμη\s+χρηματοδοτηση\s+για\s+το\s+εργο/iu,
    /3andi\s+(?:ard\s+lal\s+tatwir|tamwil\s+(?:jahez|جاهز)\s+lal\s+mashru3)/iu,
    /exo\s+(?:gi\s+gia\s+anaptyxi|etoimi\s+xrimatodotisi\s+gia\s+to\s+ergo)/iu
  ] }
]);

function normalizeWithSource(text) {
  let value = "";
  const source = [];
  // Normalize one code point at a time so the returned evidence indexes refer
  // to the original message even when accents or Arabic marks are removed.
  let offset = 0;
  for (const cp of String(text ?? "")) {
    const start = offset;
    offset += cp.length;
    let part = cp.normalize("NFKD").replace(/[\u0300-\u036f\u064B-\u065F\u0670]/gu, "").toLowerCase();
    part = part.replace(/[أإآٱ]/gu, "ا").replace(/ى/gu, "ي").replace(/ة/gu, "ه");
    for (const ch of part) { value += ch; source.push({ start, end: offset }); }
  }
  return { value, source };
}

function detectBuyingSignals(message) {
  const { value, source } = normalizeWithSource(message);
  const found = [];
  for (const signal of SIGNALS) {
    for (const authoredPattern of signal.patterns) {
      // Apply the same Unicode and Arabic folds to the authored literal text.
      const pattern = new RegExp(normalizeWithSource(authoredPattern.source).value, authoredPattern.flags);
      const match = pattern.exec(value);
      if (!match) continue;
      const start = match.index;
      const end = start + match[0].length;
      const prefix = value.slice(0, start);
      // MB-B5's Arabic anchor begins at "عندي", so "ما" is outside the
      // matched phrase. Check the immediately preceding negator as well as
      // full-prefix constructions; otherwise "ما عندي أرض للتطوير" fires.
      if (/(?:\b(?:not|never|don't|do not|doesn't|dont).{0,24}|\bno\s+tengo|\bden\s+exo|ما\s*$|لا\s*$|ليس\s*$|δεν\s*$)\s*$/iu.test(prefix)
          || /(?:ما\s+عندي|لا\s+عندي|ليس\s+لدي|δεν\s+έχω|\bno\s+tengo|\bden\s+exo)\s*$/iu.test(prefix + match[0])) continue;
      found.push(Object.freeze({
        id: signal.id,
        evidence: String(message).slice(source[start]?.start ?? 0, source[end - 1]?.end ?? 0),
        start: source[start]?.start ?? 0,
        end: source[end - 1]?.end ?? 0,
        scoreFloor: signal.scoreFloor,
        action: signal.action,
        bookingRequested: true,
        bookingConfirmed: false
      }));
      break;
    }
  }
  return Object.freeze(found);
}

function shouldEnterBookingPath(prepared = {}) {
  if (prepared.safety?.restricted === true || (Array.isArray(prepared.complianceTriggers) && prepared.complianceTriggers.length > 0)) return false;
  return prepared.classification?.intents?.includes("appointment") === true ||
    (Array.isArray(prepared.buyingSignals) && prepared.buyingSignals.some((signal) => signal.bookingRequested === true));
}

function shouldDeferBookingHandler(prepared = {}, bookingSelection = null) {
  if (prepared.safety?.restricted === true || (Array.isArray(prepared.complianceTriggers) && prepared.complianceTriggers.length > 0)) return true;
  const explicitRequest = prepared.classification?.intents?.includes("appointment") === true ||
    (Array.isArray(prepared.buyingSignals) && prepared.buyingSignals.some((signal) => signal.bookingRequested === true));
  return explicitRequest && bookingSelection?.type !== "booking";
}

module.exports = { detectBuyingSignals, shouldEnterBookingPath, shouldDeferBookingHandler };
