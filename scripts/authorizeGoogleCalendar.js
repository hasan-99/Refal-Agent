#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { google } = require("googleapis");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.freebusy"
];
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/oauth2callback";
const CREDENTIAL_KEYS = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN"];

function readLocalCredentials(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const credentials = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(GOOGLE_CALENDAR_CLIENT_ID|GOOGLE_CALENDAR_CLIENT_SECRET|GOOGLE_CALENDAR_REFRESH_TOKEN)\s*=\s*(.*)\s*$/);
    if (match) credentials[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return credentials;
}

function saveLocalCredentials(envPath, credentials) {
  for (const key of CREDENTIAL_KEYS) {
    const value = credentials[key];
    if (typeof value !== "string" || !value || /[\r\n]/.test(value)) {
      throw new Error(`Invalid value for ${key}; refusing to write credentials.`);
    }
  }
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const written = new Set();
  const updated = lines.map((line) => {
    const match = line.match(/^\s*(GOOGLE_CALENDAR_CLIENT_ID|GOOGLE_CALENDAR_CLIENT_SECRET|GOOGLE_CALENDAR_REFRESH_TOKEN)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (written.has(key)) return "";
    written.add(key);
    return `${key}=${credentials[key]}`;
  }).filter((line, index, all) => line !== "" || (index < all.length - 1 && all[index + 1] !== ""));
  for (const key of CREDENTIAL_KEYS) {
    if (!written.has(key)) updated.push(`${key}=${credentials[key]}`);
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, `${updated.join(newline).replace(/[\r\n]+$/, "")}${newline}`, { encoding: "utf8", mode: 0o600 });
}

function validateRedirectUri(value) {
  let redirect;
  try { redirect = new URL(value); } catch { throw new Error("GOOGLE_CALENDAR_REDIRECT_URI must be a valid URL."); }
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !redirect.port || redirect.pathname !== "/oauth2callback" || redirect.search || redirect.hash) {
    throw new Error("The OAuth helper only accepts an http://127.0.0.1 redirect ending in /oauth2callback.");
  }
  return redirect;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function authorize() {
  const envPath = path.resolve(process.cwd(), ".env.rafa");
  const localCredentials = readLocalCredentials(envPath);
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || localCredentials.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || localCredentials.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Add GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET to the ignored .env.rafa file before running this command.");
  }

  const redirect = validateRedirectUri(process.env.GOOGLE_CALENDAR_REDIRECT_URI || DEFAULT_REDIRECT_URI);
  const port = Number(redirect.port || 80);
  const state = crypto.randomBytes(32).toString("base64url");
  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirect.href);
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: "consent",
    scope: SCOPES,
    state
  });

  let finish;
  const server = http.createServer(async (request, response) => {
    const incoming = new URL(request.url, redirect.origin);
    if (request.method !== "GET" || incoming.pathname !== redirect.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (!safeEqual(incoming.searchParams.get("state"), state)) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("OAuth state validation failed. Close this page and retry in the terminal.");
      return;
    }
    const providerError = incoming.searchParams.get("error");
    if (providerError) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Google authorization was cancelled or denied. You can close this page.");
      finish(new Error(`Google authorization failed: ${providerError}`));
      return;
    }
    const code = incoming.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Google did not return an authorization code.");
      finish(new Error("Google did not return an authorization code."));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>RAFA Calendar authorized</title><p>Google Calendar authorization succeeded. Return to the terminal to finish setup.</p>");
    try {
      const { tokens } = await oauth.getToken(code);
      if (!tokens.refresh_token) throw new Error("Google returned no refresh token. Revoke RAFA access in your Google Account and run this command again.");
      finish(null, tokens.refresh_token);
    } catch (error) {
      finish(error);
    }
  });

  let timer;
  let settled = false;
  const result = new Promise((resolve, reject) => {
    finish = (error, refreshToken) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      error ? reject(error) : resolve(refreshToken);
    };
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log("Open this URL and authorize the Google account that owns the calendar:\n");
      console.log(url);
      console.log("\nWaiting up to 5 minutes for Google's callback...");
    });
    timer = setTimeout(() => finish(new Error("Authorization timed out. Run the command again to retry.")), 5 * 60 * 1000);
  });
  return result;
}

if (require.main === module) {
  authorize().then((refreshToken) => {
    const envPath = path.resolve(process.cwd(), ".env.rafa");
    const existing = readLocalCredentials(envPath);
    saveLocalCredentials(envPath, {
      GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID || existing.GOOGLE_CALENDAR_CLIENT_ID,
      GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || existing.GOOGLE_CALENDAR_CLIENT_SECRET,
      GOOGLE_CALENDAR_REFRESH_TOKEN: refreshToken
    });
    console.log("\nGoogle Calendar authorization complete. Credentials were saved to the ignored .env.rafa file; no secrets were printed.");
    console.log("Restart the RAFA dashboard and WhatsApp worker, then run Test calendar access in Bookings.");
  }).catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { CREDENTIAL_KEYS, DEFAULT_REDIRECT_URI, SCOPES, readLocalCredentials, safeEqual, saveLocalCredentials, validateRedirectUri };
