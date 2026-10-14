// GENERATED FILE — do not edit by hand.
// Source: src/controlledDiagnostics.js
// Generator: scripts/generateEdgeMirrors.js  (npm run edge:mirrors)
//
// The edge function is Deno and cannot require() CommonJS, so it imports this
// verbatim ESM extract instead of keeping its own copy. Hand-maintained copies
// of these exact checks drifted into fail-opens; src/mirrorParity.test.js now
// runs both implementations over a shared corpus and fails on any divergence.

// Separate, administrator-only inspection records for explicitly enrolled QA
// contacts. Ordinary operational telemetry never accepts drafted prose.
import { redactTraceText } from "./agentTracePrivacy.mjs";
const INSPECTION_CODE = /^[A-Za-z0-9_.:/,-]{1,160}$/u;
const INSPECTION_ID = /^[A-Za-z0-9_.:/-]{1,160}$/u;

function redactInspectionText(value, privateValues = []) {
  let text = redactTraceText(String(value || ""));
  for (const item of privateValues) {
    if (typeof item === "string" && item.trim().length >= 3) text = text.split(item).join("[redacted]");
  }
  return text;
}

function sanitizeControlledInspection(input = {}, privateValues = []) {
  if (!Number.isInteger(input.step) || input.step < 1 || input.step > 20) return null;
  if (!INSPECTION_ID.test(String(input.traceId || ""))) return null;
  const text = (value, limit) => redactInspectionText(value, privateValues).slice(0, limit);
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).slice(0, 30).map((item) => ({
    sourceRef: INSPECTION_ID.test(String(item?.sourceRef || "")) ? item.sourceRef : null,
    title: text(item?.title, 300), section: text(item?.section, 300), content: text(item?.content, 16000),
    contentTruncated: item?.contentTruncated === true
  }));
  if (evidence.reduce((count, item) => count + item.content.length, 0) > 30000) return null;
  return {
    traceId: input.traceId, step: input.step, type: ["respond", "clarify"].includes(input.type) ? input.type : "respond",
    draft: text(input.draft, 4000), evidence,
    reasonCodes: (Array.isArray(input.reasonCodes) ? input.reasonCodes : []).filter((item) => typeof item === "string" && INSPECTION_CODE.test(item)).slice(0, 30),
    claims: (Array.isArray(input.claims) ? input.claims : []).slice(0, 30).map((item) => ({
      sentence: text(item?.sentence || item?.claim, 1000),
      claimClass: INSPECTION_CODE.test(String(item?.claimClass || "")) ? item.claimClass : null,
      reasons: (Array.isArray(item?.reasons) ? item.reasons : []).filter((reason) => typeof reason === "string" && INSPECTION_CODE.test(reason)).slice(0, 10)
    }))
  };
}

// QA-controlled contacts may exercise the customer-initiated request flow,
// which only creates a pending team-review item. Keep calendar/confirmation
// and legacy booking states blocked while still allowing that workflow to be
// tested end to end.
function canRunControlledAppointmentWorkflow(user = {}, classification = {}) {
  if (user?.profile?.qaControlledDiagnostics !== true) return true;
  if (user?.booking?.status === "awaiting_details" && user.booking.teamReviewRequired === true) return true;
  return !user?.booking?.status && classification?.operation === "booking_request";
}

export { sanitizeControlledInspection, redactInspectionText, canRunControlledAppointmentWorkflow };
