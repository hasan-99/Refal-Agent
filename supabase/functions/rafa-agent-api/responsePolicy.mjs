// GENERATED FILE — do not edit by hand.
// Source: src/responsePolicy.js
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.

const UNCONSENTED_CONTACT_COMMITMENT = /\b(?:i|we)\s+(?:will|shall|are going to)\s+(?:contact|call|follow up|reach out|send|share)\b|\b(?:you(?:'ll|\s+will)\s+be\s+notified|we(?:'ll|\s+will)\s+(?:notify|let you know)|you\s+will\s+hear\s+back)\b|\b(?:i|we)\s+(?:have\s+)?(?:asked|requested|sent)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|\b(?:i|we)(?:'|’|’)ve\s+(?:asked|requested|sent)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|\b(?:they|he|she|the\s+team|the\s+specialist|a\s+specialist|someone)\s+will\s+(?:contact|call|follow up|reach out)\s+you\b|\b(?:i|we)\s+can\s+(?:pass|forward|send|share|arrange)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b|(?:الفريق|المختص|المختصين|حدا|شخص).{0,20}(?:رح|سوف|سيقوم|ستقوم)\s*(?:يتواصل|يتابع|يتصل)|(?:رح|سوف|سيقوم|ستقوم)\s*(?:الفريق|المختص|المختصين|حدا|شخص)?\s*(?:يتواصل|يتابع|يتصل)|(?:رح|سوف|سيتم|سنقوم|سنبلغك).{0,24}(?:إبلاغك|إعلامك|نخبرك|نبلغك)|(?:η ομάδα|ο ειδικός|θα)\s*(?:θα\s*)?(?:επικοινωνήσει|καλέσει|αναλάβει)|(?:θα επικοινωνήσει|θα σας καλέσει|θα αναλάβει|θα ενημερωθείτε|θα σας ενημερώσουμε|θα λάβετε ενημέρωση|θα μάθετε)|(?:ζητώ|ζήτησα|έχω ζητήσει|υπέβαλα αίτημα).{0,80}(?:ειδικ|ομάδα)/iu;
const CONTACT_CAPABILITY_OFFER = /\b(?:i|we)\s+can\s+(?:pass|forward|send|share|arrange)\b.{0,100}\b(?:specialist|team|contact|follow.?up|call)\b/iu;
const EXPLICIT_PERMISSION_QUESTION = /(?:\b(?:would you like|do you want|shall i|should i)\b.{0,80}\b(?:contact|call|follow.?up|specialist|team|that|this)\b|\bif you(?:'d| would) like\b.{0,80}\b(?:contact|call|follow.?up|specialist|team|arrange)\b|(?:تحب|إذا بتحب|إذا بدك|هل ترغب|هل تود).{0,80}(?:تواصل|اتصال|موعد|المختص|فريق|رتب|رتّب)|(?:θα θέλατε|αν θέλετε|θέλετε).{0,80}(?:επικοινων|κλήση|ειδικό|ραντεβού|κανονίσ))/iu;
const CONSTRUCTION_TENDER_MESSAGE = /\b(?:construction\s+tender|tender\s+(?:for\s+)?(?:construction|building)|(?:construction|building)\s+tender|bill\s+of\s+quantities|boq)\b|مناقصة\s*(?:إنشاء|بناء|عقارية)?|جدول\s+الكميات|κατασκευαστικ(?:ός|ή|ό)\s+διαγωνισμ(?:ός|ό|ο)|διαγωνισμ(?:ός|ό|ο)\s+κατασκευ/iu;
const CONSTRUCTION_PRICE_ESTIMATE = /(?:€|\$|£|\beur\b|\busd\b|\bprice\b|\bcost\b|\bestimat(?:e|ion)\b|\bquote\b|\bbid\b)|(?:θα κοστίσει|τιμή|κόστος|προσφορά|εκτίμηση)|(?:السعر|التكلفة|تقدير|عرض سعر|يورو|دولار)/iu;

export function containsUnconsentedContactCommitment(text) {
  const value = String(text || "");
  if (CONTACT_CAPABILITY_OFFER.test(value) && EXPLICIT_PERMISSION_QUESTION.test(value)) return UNCONSENTED_CONTACT_COMMITMENT.test(value.replace(CONTACT_CAPABILITY_OFFER, ""));
  return UNCONSENTED_CONTACT_COMMITMENT.test(value);
}
export function containsProhibitedConstructionEstimate(customerMessage, response) {
  return CONSTRUCTION_TENDER_MESSAGE.test(String(customerMessage || ""))
    && CONSTRUCTION_PRICE_ESTIMATE.test(String(response || ""));
}
