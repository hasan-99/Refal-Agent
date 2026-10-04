const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DEFAULT_REDIRECT_URI, SCOPES, readLocalCredentials, safeEqual, saveLocalCredentials, validateRedirectUri } = require("./authorizeGoogleCalendar.js");

test("Google Calendar OAuth helper only accepts explicit loopback callback URLs", () => {
  assert.equal(validateRedirectUri(DEFAULT_REDIRECT_URI).href, DEFAULT_REDIRECT_URI);
  assert.equal(validateRedirectUri("http://127.0.0.1:54321/oauth2callback").port, "54321");
  for (const value of [
    "https://127.0.0.1:8765/oauth2callback",
    "http://example.com:8765/oauth2callback",
    "http://localhost:8765/oauth2callback",
    "http://127.0.0.1/oauth2callback",
    "http://127.0.0.1:8765/other",
    "http://127.0.0.1:8765/oauth2callback?next=https://example.com"
  ]) assert.throws(() => validateRedirectUri(value), undefined, value);
});

test("OAuth state comparison is exact and safe for unequal lengths", () => {
  assert.equal(safeEqual("random-state", "random-state"), true);
  assert.equal(safeEqual("random-state", "different-state"), false);
  assert.equal(safeEqual("a", "longer"), false);
  assert.equal(safeEqual(undefined, ""), true);
});

test("OAuth helper requests only RAFA's event and free/busy scopes", () => {
  assert.deepEqual(SCOPES, [
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.events.freebusy"
  ]);
});

test("local OAuth credentials update only known keys and preserve unrelated settings", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafa-oauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env.rafa");
  fs.writeFileSync(envPath, "# keep me\nSUPABASE_URL=https://example.test\nGOOGLE_CALENDAR_CLIENT_ID=old\n", "utf8");

  const credentials = {
    GOOGLE_CALENDAR_CLIENT_ID: "new-id.apps.googleusercontent.com",
    GOOGLE_CALENDAR_CLIENT_SECRET: "secret-value",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-value"
  };
  saveLocalCredentials(envPath, credentials);

  const saved = fs.readFileSync(envPath, "utf8");
  assert.match(saved, /# keep me/);
  assert.match(saved, /SUPABASE_URL=https:\/\/example\.test/);
  assert.equal((saved.match(/^GOOGLE_CALENDAR_CLIENT_ID=/gm) || []).length, 1);
  assert.deepEqual(readLocalCredentials(envPath), credentials);
});

test("local OAuth credential writer preserves CRLF and rejects line injection", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafa-oauth-crlf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env.rafa");
  fs.writeFileSync(envPath, "OTHER=value\r\n", "utf8");
  const credentials = {
    GOOGLE_CALENDAR_CLIENT_ID: "client-id",
    GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-token"
  };
  saveLocalCredentials(envPath, credentials);
  assert.match(fs.readFileSync(envPath, "utf8"), /\r\n/);
  assert.throws(() => saveLocalCredentials(envPath, { ...credentials, GOOGLE_CALENDAR_REFRESH_TOKEN: "bad\nINJECTED=value" }), /Invalid value/);
});
