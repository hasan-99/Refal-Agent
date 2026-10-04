const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createCalendarReadinessTracker } = require("./calendarReadiness.js");

test("Calendar readiness requires a recent verification for the selected calendar", () => {
  const tracker = createCalendarReadinessTracker(60_000);
  const checkedAt = new Date("2026-09-30T12:00:00.000Z");
  tracker.markVerified({ calendarId: "primary", checkedAt });

  assert.equal(tracker.get("other", checkedAt), null);
  assert.equal(tracker.get("primary", new Date(checkedAt.getTime() + 60_001)), null);
  assert.equal(tracker.get("primary", new Date(checkedAt.getTime() - 1)), null);
  assert.deepEqual(tracker.get("primary", new Date(checkedAt.getTime() + 60_000)), {
    calendarId: "primary",
    checkedAt: checkedAt.toISOString()
  });
});

test("Calendar readiness can be invalidated after a failed access check or policy change", () => {
  const tracker = createCalendarReadinessTracker();
  tracker.markVerified({ calendarId: "primary", checkedAt: "2026-09-30T12:00:00.000Z" });
  tracker.invalidate();
  assert.equal(tracker.get("primary", new Date("2026-09-30T12:01:00.000Z")), null);
});
