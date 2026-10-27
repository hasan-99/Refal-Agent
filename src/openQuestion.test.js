"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveOpenQuestion } = require("./openQuestion");

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
