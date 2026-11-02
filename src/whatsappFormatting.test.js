"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeWhatsAppFormatting } = require("./whatsappFormatting");

test("converts Markdown bold labels to WhatsApp bold markers", () => {
  assert.equal(normalizeWhatsAppFormatting("**السعر**\n**ما تشمله:**"), "*السعر*\n*ما تشمله:*");
});

test("preserves other text and single-asterisk WhatsApp formatting", () => {
  const text = "السعر 999 يورو.\n*مهم:* العرض محدود.\n- نقطة";
  assert.equal(normalizeWhatsAppFormatting(text), text);
});

