const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseOAuthClientJson, readWorkerCredentials, saveWorkerCredentials, workerCredentialsReady } = require("./googleCalendarCredentialStore.js");

const clientJson = JSON.stringify({ installed: {
  client_id: "refal.apps.googleusercontent.com",
  client_secret: "client-secret-test",
  redirect_uris: ["http://127.0.0.1:8765/oauth2callback"]
} });

test("one-field OAuth JSON parser accepts only supported client credentials and callback", () => {
  assert.deepEqual(parseOAuthClientJson(clientJson), {
    GOOGLE_CALENDAR_CLIENT_ID: "refal.apps.googleusercontent.com",
    GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret-test"
  });
  assert.throws(() => parseOAuthClientJson("{}"), /client ID, client secret/);
  assert.throws(() => parseOAuthClientJson(JSON.stringify({ installed: { client_id: "id", client_secret: "secret", redirect_uris: ["https://example.test"] } })), /loopback callback/);
});

test("worker credentials are private, complete, and never mixed with dashboard settings", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refal-worker-calendar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "worker.env");
  const credentials = {
    GOOGLE_CALENDAR_CLIENT_ID: "worker-client-id",
    GOOGLE_CALENDAR_CLIENT_SECRET: "worker-client-secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "worker-refresh-token"
  };
  assert.equal(workerCredentialsReady(file), false);
  saveWorkerCredentials(credentials, file);
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => { throw new Error("read should not happen in the dashboard readiness path"); };
  try { assert.equal(workerCredentialsReady(file), true); }
  finally { fs.readFileSync = originalReadFileSync; }
  assert.deepEqual(readWorkerCredentials(file), credentials);
  const content = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(content, /SUPABASE|DASHBOARD/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => saveWorkerCredentials({ ...credentials, GOOGLE_CALENDAR_REFRESH_TOKEN: "bad\nINJECTED=yes" }, file), /complete credential set/);
});
