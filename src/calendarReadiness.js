const DEFAULT_VERIFICATION_TTL_MS = 15 * 60 * 1000;

function createCalendarReadinessTracker(ttlMs = DEFAULT_VERIFICATION_TTL_MS) {
  let verification = null;
  return {
    markVerified(value) {
      const checkedAt = new Date(value?.checkedAt || "");
      if (!String(value?.calendarId || "").trim() || !Number.isFinite(checkedAt.getTime())) {
        throw new Error("A calendar ID and valid verification time are required.");
      }
      verification = { calendarId: String(value.calendarId).trim(), checkedAt: checkedAt.toISOString() };
    },
    invalidate() { verification = null; },
    get(calendarId, now = new Date()) {
      if (!verification || verification.calendarId !== String(calendarId || "").trim()) return null;
      const age = now.getTime() - Date.parse(verification.checkedAt);
      return age >= 0 && age <= ttlMs ? { ...verification } : null;
    }
  };
}

module.exports = { DEFAULT_VERIFICATION_TTL_MS, createCalendarReadinessTracker };
