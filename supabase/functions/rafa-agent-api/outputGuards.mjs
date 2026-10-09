// GENERATED FILE — do not edit by hand.
// Source: src/outputGuards.js
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.

import { violatesBankingHonesty } from "./bankingPolicy.mjs";
import { containsRoiClaim, classifyVatStatement, violatesReservationDepositRule } from "./reservationPolicy.mjs";
import { probesAnotherCustomer } from "./crossCustomerPolicy.mjs";

// The M2 output guards that no amount of approved evidence can satisfy.
//
// WHY THIS MODULE EXISTS. P2.3, P2.4 and the cross-customer rule each produced a
// correct, well-tested detector, and none of them had a live caller. The P2.6
// red-team sweep measured exactly what that costs:
//
//   * no ROI claim class ran on the answer side at all, so a chunk carrying a
//     yield figure unlocked the statement (MB-F55);
//   * 16 of 29 cross-customer probes were refused by nothing;
//   * a bank-approval promise was only caught when it also tripped the blanket
//     topic regex.
//
// Aggregating them here rather than calling four modules from `refalcoAnswer`
// keeps that file's import surface to ONE new symbol, which matters because the
// edge function mirrors it (see scripts/generateEdgeMirrors.js) and every extra
// import there is a hand-maintained line.
//
// Everything in this module is UNCONDITIONAL. These are not "facts that need
// evidence"; they are assertions REFAL must not make whatever the corpus says.
// Evidence-gated grounding is `claimPolicy`'s job, not this one's.

// P2.6 wiring defect OG-1 (High). Wiring these guards into the live gate made
// REFAL flag EIGHT of its own approved refusals:
//
//   * all three investment refusals in `refalcoAnswer.restrictedRefalcoReply`
//     and all three `safetyPolicy.FALLBACKS[*].investment` strings, because
//     saying "I cannot provide information about returns" contains the word
//     "returns" / "العوائد" / "αποδόσεις";
//   * all three `crossCustomerPolicy.REFUSAL` strings, because the refusal to
//     discuss another client's file necessarily names another client's file.
//
// The measured consequence was a real regression: `src/ragPolicy.test.js`
// "Arabic legal and investment questions are refused in Arabic before AI"
// started failing, because `validateResponse` rejected the correct Arabic
// refusal as a prohibited claim and substituted a vaguer fallback. REFAL
// deleting its own refusal is worse than the claim the gate was defending
// against.
//
// So a complete REFUSAL clause is stripped before the guards run, exactly as
// `claimPolicy` strips a negated guarantee.
//
// The span boundary is the subtle part. Stopping at every comma looked right and
// was wrong: these refusals ENUMERATE what is being refused ("investment,
// financial-return, or financial-advice information"), so a comma stop left the
// very word the guard hunts for standing alone. Stopping only at a sentence end
// is wrong in the other direction: "I cannot promise a yield, but you can expect
// 8% returns" would lose its second half, which is the trap `claimPolicy`
// documents for negated guarantees.
//
// The span therefore runs to a sentence terminator OR to a CONTRASTIVE
// conjunction, whichever comes first. An enumeration survives; a pivot into an
// affirmative promise does not.
const CONTRASTIVE = "(?:but|however|although|though|yet|still)|ولكن|لكن|بس|غير\\s+أن|إلا\\s+أن|αλλά|όμως|ωστόσο|παρόλα";
const REFUSAL_BODY = `(?:(?!\\s*(?:${CONTRASTIVE})(?![\\p{L}\\p{N}]))[^.!?;؟؛]){0,160}`;
const REFUSAL_CLAUSE = new RegExp(
  `(?:\\b(?:i|we|refal|refalco|business)\\s+)?\\b(?:can(?:not|['’]t)|cannot|could\\s+not|couldn['’]t|do(?:es)?\\s+not|don['’]t|will\\s+not|won['’]t|never)\\s+(?:provide|give|offer|share|discuss|disclose|confirm|comment\\s+on|quote|promise|guarantee)\\b${REFUSAL_BODY}`
  + `|\\b(?:i|we|refal|refalco|business)\\s+(?:can\\s+)?only\\s+discuss\\b${REFUSAL_BODY}`
  + `|(?:لا\\s+(?:أستطيع|يمكنني|أقدم|أوفر|نقدم|نستطيع)|ما\\s+(?:فيني|بقدر|منقدر|بنقدر))\\s*(?:تقديم|إعطاء|مشاركة|أشارك|نشارك|مناقشة|أناقش|تأكيد|أؤكد|أضمن|نضمن|أحكي|الحديث)?${REFUSAL_BODY}`
  + `|δεν\\s+(?:μπορ\\p{L}+\\s+να\\s+)?(?:παρέχ\\p{L}+|δίν\\p{L}+|δώσ\\p{L}+|μοιραστ\\p{L}+|συζητ\\p{L}+|σχολιάσ\\p{L}+|επιβεβαιώσ\\p{L}+|εγγυηθ\\p{L}+)${REFUSAL_BODY}`,
  "giu"
);

function withoutRefusalClauses(text) {
  return String(text).replace(REFUSAL_CLAUSE, " ");
}

const OUTPUT_GUARD_REASONS = Object.freeze({
  BANKING_PROMISE: "banking_promise",
  ROI_CLAIM: "roi_claim",
  PERSONALIZED_VAT_RATE: "personalized_vat_rate",
  UNSOURCED_RESERVATION_DEPOSIT: "unsourced_reservation_deposit",
  CROSS_CUSTOMER: "cross_customer"
});

/**
 * @param {string} text
 * @param {{ reservationSource?: string|null, language?: string }} [options]
 *   `reservationSource` is the provenance of any deposit figure in `text`.
 *   MB-F50 is absolute: only the live `refal_reservation_rules` table (M4)
 *   may supply one, so the default of `null` means default-deny. A caller that
 *   genuinely read the table passes its name through.
 * @returns {string[]} reason codes, empty when the text is clean
 */
function outputGuardViolations(text, { reservationSource = null, language } = {}) {
  const value = withoutRefusalClauses(String(text === null || text === undefined ? "" : text));
  if (!value.trim()) return [];
  const reasons = [];
  if (violatesBankingHonesty(value)) reasons.push(OUTPUT_GUARD_REASONS.BANKING_PROMISE);
  if (containsRoiClaim(value)) reasons.push(OUTPUT_GUARD_REASONS.ROI_CLAIM);
  if (classifyVatStatement(value, { language }).personalizedRateConclusion) reasons.push(OUTPUT_GUARD_REASONS.PERSONALIZED_VAT_RATE);
  if (violatesReservationDepositRule(value, { source: reservationSource })) reasons.push(OUTPUT_GUARD_REASONS.UNSOURCED_RESERVATION_DEPOSIT);
  if (probesAnotherCustomer(value)) reasons.push(OUTPUT_GUARD_REASONS.CROSS_CUSTOMER);
  return reasons;
}

function violatesOutputGuards(text, options) {
  return outputGuardViolations(text, options).length > 0;
}

export { OUTPUT_GUARD_REASONS, outputGuardViolations, violatesOutputGuards };
