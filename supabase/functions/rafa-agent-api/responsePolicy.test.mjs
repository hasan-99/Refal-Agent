import { test } from "node:test";
import assert from "node:assert/strict";
import { containsUnconsentedContactCommitment } from "./responsePolicy.mjs";

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
