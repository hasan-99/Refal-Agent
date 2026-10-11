#!/usr/bin/env node
const crypto = require("node:crypto");
const http = require("node:http");
const { google } = require("googleapis");
const { DEFAULT_WORKER_CREDENTIALS_PATH, loadWorkerCredentialsIntoEnvironment, parseOAuthClientJson, saveWorkerCredentials } = require("./googleCalendarCredentialStore.js");

const CALLBACK = "http://127.0.0.1:8765/oauth2callback";
const SCOPES = ["https://www.googleapis.com/auth/calendar.events.owned", "https://www.googleapis.com/auth/calendar.events.freebusy"];
const safeWrite = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const readStdin = () => new Promise((resolve, reject) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 4096) reject(new Error("Setup token is invalid.")); });
  process.stdin.on("end", () => resolve(input));
  process.stdin.on("error", reject);
});
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const safeClientError = (error) => {
  if (error?.message === "Paste a valid Google OAuth client JSON file." || error?.message?.includes("OAuth JSON must")) return error.message;
  return "The OAuth client JSON could not be accepted. Check it and retry.";
};

async function authorize(setupToken) {
  let client;
  let oauth;
  let state;
  let settled = false;
  let timer;
  let finish;
  const result = new Promise((resolve, reject) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      error ? reject(error) : resolve();
    };
  });
  const server = http.createServer(async (request, response) => {
    const incoming = new URL(request.url, CALLBACK);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (request.method === "POST" && incoming.pathname === "/credentials") {
      let body = "";
      request.setEncoding("utf8");
      try {
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 1024 * 1024 + 4096) throw new Error("The OAuth client JSON is too large.");
        }
        const form = new URLSearchParams(body);
        if (!safeEqual(form.get("token"), setupToken)) throw new Error("This setup form is no longer valid. Start again from REFAL Dashboard.");
        if (oauth) throw new Error("This setup form was already used. Start again from REFAL Dashboard.");
        client = parseOAuthClientJson(form.get("clientJson") || "");
        oauth = new google.auth.OAuth2(client.GOOGLE_CALENDAR_CLIENT_ID, client.GOOGLE_CALENDAR_CLIENT_SECRET, CALLBACK);
        state = crypto.randomBytes(32).toString("base64url");
        const authUrl = oauth.generateAuthUrl({ access_type: "offline", include_granted_scopes: true, prompt: "consent", scope: SCOPES, state });
        const safeUrl = authUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html("Continue to Google", `<p>Continue to Google to grant REFAL the requested calendar event and availability access.</p><p><a rel="noreferrer" href="${safeUrl}">Authorize REFAL Calendar</a></p><p>After consent, return to REFAL Dashboard and test calendar access.</p>`));
        safeWrite({ type: "authorization_started" });
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("Authorization timed out. Start the setup again.")), 5 * 60 * 1000);
      } catch (error) {
        const message = error.message === "The OAuth client JSON is too large." || error.message === "This setup form is no longer valid. Start again from REFAL Dashboard." ? error.message : safeClientError(error);
        response.writeHead(error.message?.includes("no longer valid") ? 403 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(html("Calendar setup could not continue", `<p>${message}</p>`));
      }
      return;
    }
    if (request.method !== "GET" || incoming.pathname !== "/oauth2callback") return response.writeHead(404).end("Not found");
    if (!oauth || !safeEqual(incoming.searchParams.get("state"), state)) return response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(html("Calendar setup expired", "<p>Return to REFAL Dashboard and start again.</p>"));
    if (incoming.searchParams.get("error")) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(html("Authorization cancelled", "<p>Google authorization was cancelled. Return to REFAL Dashboard to retry.</p>"));
      return finish(new Error("Google authorization was cancelled or denied."));
    }
    const code = incoming.searchParams.get("code");
    if (!code) return response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(html("Authorization failed", "<p>Google did not return an authorization code.</p>"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html("REFAL Calendar authorized", "<p>Google Calendar authorization succeeded. Return to REFAL Dashboard and test access.</p>"));
    try {
      const { tokens } = await oauth.getToken(code);
      if (!tokens.refresh_token) throw new Error("Google returned no refresh token. Revoke REFAL access and retry authorization.");
      saveWorkerCredentials({ ...client, GOOGLE_CALENDAR_REFRESH_TOKEN: tokens.refresh_token });
      finish(null);
    } catch (error) { finish(error); }
  });
  server.once("error", () => finish(new Error("Calendar authorization callback could not start. Close other setup sessions and retry.")));
  server.listen(8765, "127.0.0.1", () => safeWrite({ type: "setup_ready", token: setupToken }));
  timer = setTimeout(() => finish(new Error("Authorization timed out. Start the setup again.")), 5 * 60 * 1000);
  await result;
  safeWrite({ type: "complete", configured: true });
}

async function verify(policy) {
  if (!loadWorkerCredentialsIntoEnvironment()) throw new Error("Worker calendar authorization is not configured.");
  const { verifyCalendarAccess } = require("../src/booking.js");
  const access = await verifyCalendarAccess(policy);
  safeWrite({ type: "verified", access: { calendarId: String(access.calendarId || ""), checkedAt: String(access.checkedAt || "") } });
}

async function performBookingReview({ action, appointmentId, reviewer, reason, store, approve, change, now = new Date() }) {
  if (!/^[0-9a-f-]{16,64}$/i.test(String(appointmentId || ""))) throw new Error("Appointment was not found.");
  if (action === "approve") {
    const result = await approve({ store, appointmentId, reviewer, now });
    return { appointment: result.appointment, event: result.event, policy: result.policy, reminderError: result.reminderError || "" };
  }
  if (action === "cancel" || action === "reschedule") {
    const appointment = await store.getAppointment(appointmentId);
    if (!appointment) throw new Error("Appointment was not found.");
    const status = action === "cancel" ? "cancelled" : "rescheduled";
    const updated = await change({ store, appointmentId, status, actor: reviewer, reason, now });
    return { appointment, updated };
  }
  throw new Error("Unsupported appointment review action.");
}

function safeBookingReviewError(error) {
  const known = new Set([
    "Appointment was not found.",
    "Only a pending appointment can be approved.",
    "Only an active appointment can be changed.",
    "The requested time is no longer within the booking window. Reject it and ask the customer to choose another time.",
    "The requested time is no longer available. Reject it and ask the customer to choose another time.",
    "The customer contact could not be loaded.",
    "Google Calendar did not return a Meet link. The appointment remains pending review; check Calendar conference settings and retry.",
    "Calendar event was created, but the appointment confirmation could not be saved."
  ]);
  if (error?.calendarChanged) return "Google Calendar changed, but the appointment status did not save. Admin reconciliation is required.";
  return known.has(error?.message) ? error.message : "The calendar appointment action failed. Check calendar access and retry.";
}

async function main() {
  try {
    const input = await readStdin();
    if (process.argv[2] === "authorize") await authorize(input);
    else if (process.argv[2] === "verify") await verify(JSON.parse(input));
    else if (process.argv[2] === "review") {
      const payload = JSON.parse(input);
      const root = require("node:path").resolve(__dirname, "..");
      require("../src/env.js").loadProjectEnv(root);
      for (const key of ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN", "GOOGLE_CALENDAR_CLIENT_EMAIL", "GOOGLE_CALENDAR_PRIVATE_KEY"]) delete process.env[key];
      loadWorkerCredentialsIntoEnvironment();
      if (!loadWorkerCredentialsIntoEnvironment()) throw new Error("Calendar authorization is not configured.");
      const store = require("../src/supabaseStore.js").createStore();
      const booking = require("../src/booking.js");
      const result = await performBookingReview({ ...payload, store, approve: booking.approvePendingAppointment, change: booking.changeAppointmentStatus });
      safeWrite({ type: "reviewed", result });
    }
    else throw new Error("Unsupported worker operation.");
  } catch (error) {
    const message = process.argv[2] === "authorize"
      ? (error?.message?.includes("Google authorization was cancelled") || error?.message?.includes("Authorization timed out") || error?.message?.includes("callback could not start") ? error.message : "Google Calendar authorization failed. Check the OAuth client configuration and retry.")
      : process.argv[2] === "review" ? safeBookingReviewError(error) : "Google Calendar access could not be verified. Check the worker credentials and calendar permission.";
    safeWrite({ type: "error", message });
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = { CALLBACK, DEFAULT_WORKER_CREDENTIALS_PATH, SCOPES, safeEqual, safeClientError, performBookingReview, safeBookingReviewError };
