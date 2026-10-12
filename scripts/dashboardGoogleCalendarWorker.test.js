const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const { performBookingReview, safeBookingReviewError, safeClientError } = require("./dashboardGoogleCalendarWorker.js");

function postForm(body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: 8765, path: "/credentials", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("local onboarding accepts browser form directly and never echoes client secret", async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, "dashboardGoogleCalendarWorker.js"), "authorize"], { cwd: path.resolve(__dirname, ".."), env: {}, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { if (!child.killed) child.kill(); });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Local OAuth helper did not start in time.")), 15000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const line = output.split(/\r?\n/).find(Boolean);
      if (!line) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "setup_ready") { clearTimeout(timer); resolve(event.token); }
        if (event.type === "error") { clearTimeout(timer); reject(new Error("Helper startup failed safely.")); }
      } catch { /* Wait for the full JSON line. */ }
    });
  });
  child.stdin.end("one-use-test-token");
  const token = await ready;
  const clientJson = JSON.stringify({ installed: { client_id: "synthetic.apps.googleusercontent.com", client_secret: "synthetic-client-secret", redirect_uris: ["http://127.0.0.1:8765/oauth2callback"] } });
  const body = new URLSearchParams({ token, clientJson }).toString();
  const response = await postForm(body);
  assert.equal(response.status, 200);
  assert.match(response.text, /accounts\.google\.com/);
  assert.doesNotMatch(response.text, /synthetic-client-secret/);
  assert.doesNotMatch(response.text, /refresh_token/);
  const replay = await postForm(body);
  assert.equal(replay.status, 400);
  assert.doesNotMatch(replay.text, /synthetic-client-secret/);
});

test("OAuth client errors are safe and do not echo provider details", () => {
  assert.equal(safeClientError(new Error("client_secret=private-value")), "The OAuth client JSON could not be accepted. Check it and retry.");
});

test("isolated approve returns only the dashboard-required booking summary", async () => {
  const appointment = { id: "12345678-1234-1234-1234-123456789abc", status: "confirmed" };
  const event = { id: "event-1", meetLink: "https://meet.google.com/abc-defg-hij" };
  const result = await performBookingReview({
    action: "approve", appointmentId: appointment.id, reviewer: "admin@example.test", now: new Date("2026-10-11T08:00:00Z"),
    store: {},
    approve: async (input) => { assert.equal(input.appointmentId, appointment.id); return { appointment, event, policy: { timezone: "Europe/Nicosia" }, reminderError: "", user: { secret: "omitted" } }; }
  });
  assert.deepEqual(result, { appointment, event, policy: { timezone: "Europe/Nicosia" }, reminderError: "" });
});

test("isolated cancel delegates the exact cancelled transition", async () => {
  const appointment = { id: "12345678-1234-1234-1234-123456789abc", whatsapp_jid: "35799123456@s.whatsapp.net" };
  let changed;
  const result = await performBookingReview({
    action: "cancel", appointmentId: appointment.id, reviewer: "admin@example.test", reason: "Requested", store: { getAppointment: async () => appointment },
    change: async (input) => { changed = input; return { ...appointment, status: input.status }; }
  });
  assert.equal(changed.status, "cancelled");
  assert.equal(changed.actor, "admin@example.test");
  assert.equal(changed.reason, "Requested");
  assert.deepEqual(result, { appointment, updated: { ...appointment, status: "cancelled" } });
});

test("isolated calendar review failures return only safe known or generic messages", async () => {
  assert.equal(safeBookingReviewError(new Error("Google Calendar returned client_secret=private-value")), "The calendar appointment action failed. Check calendar access and retry.");
  assert.equal(safeBookingReviewError(new Error("Only a pending appointment can be approved.")), "Only a pending appointment can be approved.");
  await assert.rejects(performBookingReview({ action: "cancel", appointmentId: "12345678-1234-1234-1234-123456789abc", store: { getAppointment: async () => null } }), /Appointment was not found/);
});
