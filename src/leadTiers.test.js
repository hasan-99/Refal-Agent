"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyLeadTier } = require("./leadTiers");

test("classifies every exact tier boundary and applies the approved action contract", () => {
  for (const [score, tier] of [[0,"informational"],[7,"informational"],[8,"cold"],[13,"cold"],[14,"warm"],[19,"warm"],[20,"hot"],[24,"hot"],[25,"strategic"],[30,"strategic"]]) assert.equal(classifyLeadTier(score).tier, tier);
  assert.equal(classifyLeadTier(0).offerBooking, false);
  assert.equal(classifyLeadTier(10).followUp, "quiet");
  assert.equal(classifyLeadTier(17).followUp, "flexible");
  assert.equal(classifyLeadTier(22).followUp, "consent_gated");
  assert.equal(classifyLeadTier(28).escalate, true);
});

test("buying signal floors lift a tier without fabricating dimension scores", () => {
  assert.deepEqual(classifyLeadTier(9, { scoreFloor: 25 }), { baseTotal: 9, scoreFloor: 25, total: 25, tier: "strategic", boundaries: [25,30], askQuestion: false, offerBooking: true, followUp: "consent_gated", suppressSalesHooks: true, escalate: true });
});
