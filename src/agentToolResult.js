// The one shared shape every Agent tool result uses (Ticket 001 contract).
//
// Extracted from agentTools.js in REFAL-AGENT-009 only so that a second tool
// module (agentBookingTools.js) can produce the identical shape without a
// circular require back into agentTools.js — agentTools.js still re-exports
// `ok`/`fail`, so every existing caller and test keeps working unchanged.

function ok(status, data, extra = {}) {
  return { ok: true, status, data, ...extra };
}

function fail(status, reasonCode, extra = {}) {
  return { ok: false, status, reasonCode, ...extra };
}

module.exports = { ok, fail };
