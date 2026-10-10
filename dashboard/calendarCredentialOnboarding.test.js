import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCalendarCredentialOnboarding } from "./calendarCredentialOnboarding.js";

function childFor(output, status = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = { end(value) { child.input = value; queueMicrotask(() => { const event = typeof output === "function" ? output(child) : output; child.stdout.emit("data", `${JSON.stringify(event)}\n`); if (status !== null) child.emit("close", status); }); } };
  child.kill = () => child.emit("close", 1);
  return child;
}

test("admin OAuth setup passes only a one-use token through dashboard and strips inherited credentials", async () => {
  const children = [];
  const onboarding = createCalendarCredentialOnboarding({
    botRoot: "C:/refal",
    env: { DASHBOARD_MODE: "test", GOOGLE_CALENDAR_CLIENT_SECRET: "must-not-be-inherited" },
    spawn: (_exe, args, options) => {
      const child = childFor((current) => ({ type: "setup_ready", token: current.input }), null);
      child.options = options; child.args = args; children.push(child); return child;
    }
  });
  const result = await onboarding.start();
  assert.equal(result.status, "awaiting_credentials");
  assert.equal(result.submissionUrl, "http://127.0.0.1:8765/credentials");
  assert.match(result.setupToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(children[0].input, result.setupToken);
  assert.deepEqual(children[0].args.slice(1), ["authorize"]);
  assert.equal(children[0].options.env.GOOGLE_CALENDAR_CLIENT_SECRET, undefined);
  assert.equal(JSON.stringify(result).includes("must-not-be-inherited"), false);
  assert.equal(onboarding.status, "awaiting_credentials");
});

test("calendar access helper returns only a safe verified access summary", async () => {
  const onboarding = createCalendarCredentialOnboarding({
    botRoot: "C:/refal",
    env: {},
    spawn: () => childFor({ type: "verified", access: { calendarId: "primary", checkedAt: "2026-10-11T08:00:00.000Z" } })
  });
  assert.deepEqual(await onboarding.verify({ calendarId: "primary" }), { calendarId: "primary", checkedAt: "2026-10-11T08:00:00.000Z" });
});

test("dashboard review bridge uses the isolated helper with sanitized environment", async () => {
  const result = { appointment: { id: "appointment-id", status: "confirmed" }, event: { meetLink: "https://meet.google.com/test" }, policy: { timezone: "Europe/Nicosia" }, reminderError: "" };
  let input;
  let childEnv;
  const onboarding = createCalendarCredentialOnboarding({
    botRoot: "C:/refal",
    env: { GOOGLE_CALENDAR_PRIVATE_KEY: "worker-private-key", DASHBOARD_MODE: "test" },
    spawn: (_exe, args, options) => {
      const child = childFor({ type: "reviewed", result });
      child.stdin.end = (value) => { input = value; childEnv = options.env; queueMicrotask(() => { child.stdout.emit("data", `${JSON.stringify({ type: "reviewed", result })}\n`); child.emit("close", 0); }); };
      assert.deepEqual(args.slice(1), ["review"]);
      return child;
    }
  });
  assert.deepEqual(await onboarding.review({ action: "approve", appointmentId: "12345678-1234-1234-1234-123456789abc" }), result);
  assert.equal(JSON.parse(input).action, "approve");
  assert.equal(childEnv.GOOGLE_CALENDAR_PRIVATE_KEY, undefined);
});
