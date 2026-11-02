"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveOpenQuestion, deriveContinuedLookupRequest } = require("./openQuestion");

test("deriveOpenQuestion returns only a trailing assistant question, not facts or earlier prompts", () => {
  assert.equal(deriveOpenQuestion({ response: "What business activity will you have?" }), "What business activity will you have?");
  assert.equal(deriveOpenQuestion({ response: "Which city? Is the property residential or commercial?" }), "Is the property residential or commercial?");
  assert.equal(deriveOpenQuestion({ response: "ما النشاط الذي ستزاوله الشركة؟" }), "ما النشاط الذي ستزاوله الشركة؟");
  assert.equal(deriveOpenQuestion({ response: "Ποια δραστηριότητα θα έχει η εταιρεία;" }), "Ποια δραστηριότητα θα έχει η εταιρεία;");
  assert.equal(deriveOpenQuestion({ response: "I can check that with the team." }), null);
  assert.equal(deriveOpenQuestion({ response: "What activity? Thanks, I can help." }), null);
  assert.equal(deriveOpenQuestion(null), null);
});

test("a permitted trailing persona emoji does not hide an outstanding question", () => {
  assert.equal(deriveOpenQuestion({ response: "What activity will the company have? 😄" }), "What activity will the company have?");
  assert.equal(deriveOpenQuestion({ response: "شو نشاط الشركة؟ 👀" }), "شو نشاط الشركة؟");
  assert.equal(deriveOpenQuestion({ response: "Ποια δραστηριότητα θα έχει η εταιρεία; 👍" }), "Ποια δραστηριότητα θα έχει η εταιρεία;");
  assert.equal(deriveOpenQuestion({ response: "I can help with that. 😄" }), null);
});

test("accepting a lookup offer keeps every part of the original customer request active", () => {
  const recentConversation = [
    { role: "user", content: "What is the package price, what is included, and what is excluded?" },
    { role: "assistant", content: "I can look up the approved package details if you'd like." }
  ];
  assert.equal(deriveContinuedLookupRequest("Yes, please look it up.", recentConversation),
    "What is the package price, what is included, and what is excluded?");
});

test("a lookup offer continuation does not revive an older request after a different assistant reply", () => {
  const recentConversation = [
    { role: "user", content: "What is the package price and what is excluded?" },
    { role: "assistant", content: "The price is not confirmed. What service are you interested in?" }
  ];
  assert.equal(deriveContinuedLookupRequest("Yes, please look it up.", recentConversation), null);
});

test("lookup-offer continuation is recognized with Arabic and Greek wording", () => {
  assert.equal(deriveContinuedLookupRequest("أكيد، لو سمحت ابحث عنها.", [
    { role: "user", content: "شو السعر وشو بيشمل وشو ما بيشمل؟" },
    { role: "assistant", content: "فيني أبحث عن تفاصيل الباقة المعتمدة إذا بتحب." }
  ]), "شو السعر وشو بيشمل وشو ما بيشمل؟");
  assert.equal(deriveContinuedLookupRequest("Ναι, παρακαλώ.", [
    { role: "user", content: "Ποια είναι η τιμή και τι περιλαμβάνεται και εξαιρείται;" },
    { role: "assistant", content: "Μπορώ να ελέγξω τις εγκεκριμένες λεπτομέρειες αν θέλετε." }
  ]), "Ποια είναι η τιμή και τι περιλαμβάνεται και εξαιρείται;");
});
