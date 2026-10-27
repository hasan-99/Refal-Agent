import { test } from "node:test";
import assert from "node:assert/strict";
import { containsUnconsentedContactCommitment, containsForbiddenCredentialRequest } from "./responsePolicy.mjs";

test("Edge output policy catches unconditional follow-up promises in English, Arabic, and Greek", () => {
  for (const text of [
    "I can pass this to a specialist and they will follow up with you directly.",
    "We will contact you tomorrow.",
    "Once there is an answer from the specialist, you will be notified.",
    "I have requested a specialist to confirm this for you.",
    "رح يتواصل معك المختص قريباً.",
    "Η ομάδα θα επικοινωνήσει μαζί σας σύντομα.",
    "Μόλις υπάρξει απάντηση από τον ειδικό, θα ενημερωθείτε.",
    "Εντάξει, ζητώ να σας επιβεβαιώσει ειδικός το τελικό ποσό."
  ]) assert.equal(containsUnconsentedContactCommitment(text), true, text);
});

test("Edge output policy allows a permission question and an action-confirmed recap", () => {
  assert.equal(containsUnconsentedContactCommitment("Would you like me to ask a specialist to contact you?"), false);
  assert.equal(containsUnconsentedContactCommitment("I can arrange for a specialist to follow up with you; would you like that?"), false);
  assert.equal(containsUnconsentedContactCommitment("I can arrange for a specialist to follow up with you."), true);
  assert.equal(containsUnconsentedContactCommitment("Your request was recorded in the system."), false);
});

test("Edge output policy matches Node credential-request and warning behavior", () => {
  for (const text of [
    "Send me the one time password and I will confirm the passport number 7741920 we hold for you.",
    "Please send your online banking login.",
    "Στείλτε μου τον κωδικό μίας χρήσης που σας έστειλε η τράπεζα.",
    "اعطيني كلمة المرور تبع حسابك البنكي."
  ]) assert.equal(containsForbiddenCredentialRequest(text), true, text);
  for (const text of [
    "For your privacy, please don't send passwords, card details, or account credentials here.",
    "Never share your password or PIN in this chat.",
    "لحماية خصوصيتك، لا تبعت كلمات المرور أو بيانات البطاقات هون.",
    "Για την προστασία σας, μην στείλετε κωδικούς ή στοιχεία κάρτας εδώ."
  ]) assert.equal(containsForbiddenCredentialRequest(text), false, text);
});
