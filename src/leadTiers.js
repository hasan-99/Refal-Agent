"use strict";

const BOUNDARIES = Object.freeze({ informational: [0, 7], cold: [8, 13], warm: [14, 19], hot: [20, 24], strategic: [25, 30] });

function classifyLeadTier(score, { scoreFloor = 0 } = {}) {
  const base = Number.isFinite(Number(score)) ? Math.max(0, Math.min(30, Math.round(Number(score)))) : 0;
  const floor = Number.isFinite(Number(scoreFloor)) ? Math.max(0, Math.min(30, Math.round(Number(scoreFloor)))) : 0;
  const total = Math.max(base, floor);
  const tier = Object.entries(BOUNDARIES).find(([, [min, max]]) => total >= min && total <= max)?.[0] || "informational";
  const actions = {
    informational: { askQuestion: false, offerBooking: false, followUp: "none", suppressSalesHooks: true, escalate: false },
    cold: { askQuestion: true, offerBooking: false, followUp: "quiet", suppressSalesHooks: true, escalate: false },
    warm: { askQuestion: true, offerBooking: true, followUp: "flexible", suppressSalesHooks: false, escalate: false },
    hot: { askQuestion: false, offerBooking: true, followUp: "consent_gated", suppressSalesHooks: true, escalate: false },
    strategic: { askQuestion: false, offerBooking: true, followUp: "consent_gated", suppressSalesHooks: true, escalate: true }
  };
  return Object.freeze({ baseTotal: base, scoreFloor: floor, total, tier, boundaries: BOUNDARIES[tier], ...actions[tier] });
}

module.exports = { BOUNDARIES, classifyLeadTier };
