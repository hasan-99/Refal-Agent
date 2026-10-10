const test = require("node:test");
const assert = require("node:assert/strict");
const { detectBuyingSignals, shouldEnterBookingPath, shouldDeferBookingHandler } = require("./buyingSignals");

const cases = [
  ["MB-B1", "كيف أبدأ الإجراءات معك؟", "How do I start the procedures with you?", "Πως ξεκιναω τη διαδικασια μαζι σας;", "keef ballesh el ijra2at ma3ak?", "pos na arxiso ti diadikasia mazi sas?"],
  ["MB-B2", "شو الأوراق المطلوبة مني الآن؟", "What documents do you need from me now?", "Ποια εγγραφα χρειαζεστε απο εμενα τωρα;", "shu el awra2 el matlube minni halla2?", "pia engrafa xreiazeste apo mena tora?"],
  ["MB-B3", "طريقة الدفع وكيف بأكد الحجز؟", "Payment method and how do I confirm the booking?", "Τροπος πληρωμης και πως επιβεβαιωνω την κρατηση;", "tari2et ed dafa3 we keef b2akked el 7ajz?", "tropos pliromis kai pos epiveveono tin kratisi?"],
  ["MB-B4", "ممكن أكلم المستشار أو أزور مكتبكم؟", "Can I speak to the consultant or visit your office?", "Μπορω να μιλησω με τον συμβουλο η να επισκεφτω το γραφειο σας;", "momken ehki ma3 el mostashar aw azur makatabkom?", "boro na miliso me ton symvoulo i na episkeftho to grafeio sas?"],
  ["MB-B5", "عندي أرض للتطوير", "I have land for development", "Εχω γη για αναπτυξη", "3andi ard lal tatwir", "exo gi gia anaptyxi"],
  ["MB-B5", "عندي تمويل جاهز للمشروع", "I have financing ready for the project", "Εχω ετοιμη χρηματοδοτηση για το εργο", "3andi tamwil جاهز lal mashru3", "exo etoimi xrimatodotisi gia to ergo"]
];

for (const [id, ...locales] of cases) {
  for (const [index, input] of locales.entries()) {
    test(`${id} matches locale ${index + 1} and returns evidence with guarded action metadata`, () => {
      const [signal] = detectBuyingSignals(input);
      assert.equal(signal.id, id);
      assert.ok(input.includes(signal.evidence));
      assert.equal(input.slice(signal.start, signal.end), signal.evidence);
      assert.equal(signal.bookingRequested, true);
      assert.equal(signal.bookingConfirmed, false);
      assert.equal(signal.action, id === "MB-B5" ? "priority_booking_escalation" : "offer_booking");
      assert.equal(signal.scoreFloor, id === "MB-B5" ? 25 : 20);
    });
  }
}

test("diacritics and Arabic letter variants normalize without losing original evidence span", () => {
  const arabic = "شو الأوراق المطلوبة مني الآن؟";
  const [ar] = detectBuyingSignals(arabic.replace("الأوراق", "الأوْراق"));
  assert.equal(ar.id, "MB-B2");
  assert.equal(ar.evidence, "شو الأوْراق المطلوبة مني الآن");
  const [el] = detectBuyingSignals("Ποιά έγγραφα χρειάζεστε από εμένα τώρα;");
  assert.equal(el.id, "MB-B2");
  assert.equal(el.evidence, "Ποιά έγγραφα χρειάζεστε από εμένα τώρα");
});

test("irrelevant, negated, and merely related messages do not trigger", () => {
  for (const message of [
    "What documents are generally used?",
    "I don't have land for development.",
    "لا أملك أرض للتطوير",
    "ما عندي أرض للتطوير",
    "Δεν έχω γη για ανάπτυξη",
    "Can I visit your website?",
    "شو تكلفة المشروع؟",
    "I am not asking how to start the procedures with you."
  ]) assert.deepEqual(detectBuyingSignals(message), [], message);
});

test("a match exposes no booking or handover execution capability", () => {
  const [signal] = detectBuyingSignals("How do I start the procedures with you?");
  assert.equal("book" in signal, false);
  assert.equal("handover" in signal, false);
  assert.equal("confirmed" in signal, false);
});

test("booking dispatch accepts buying signals but safety and compliance routes take precedence", () => {
  const signal = detectBuyingSignals("I have land for development");
  const allowed = { buyingSignals: signal, safety: { restricted: false }, complianceTriggers: [] };
  const booking = { type: "booking" };
  assert.equal(shouldEnterBookingPath(allowed), true);
  assert.equal(shouldDeferBookingHandler(allowed, booking), false);
  assert.equal(shouldEnterBookingPath({ buyingSignals: signal, safety: { restricted: true } }), false);
  assert.equal(shouldDeferBookingHandler({ buyingSignals: signal, safety: { restricted: true } }, booking), true);
  const mixedRisk = { ...allowed, complianceTriggers: [{ category: "sanctions" }] };
  assert.equal(shouldEnterBookingPath(mixedRisk), false);
  assert.equal(shouldDeferBookingHandler(mixedRisk, null), true);
  assert.equal(shouldDeferBookingHandler({ classification: { intents: ["appointment"] }, complianceTriggers: [{ category: "sanctions" }] }, booking), true);
  assert.equal(shouldDeferBookingHandler({ bookingState: "awaiting_details" }, null), false, "normal booking continuations still reach the handler");
});
