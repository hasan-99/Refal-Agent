const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const WORKER_CALENDAR_KEYS = Object.freeze([
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REFRESH_TOKEN"
]);
const DEFAULT_WORKER_CREDENTIALS_PATH = path.resolve(__dirname, "..", ".secrets", "google-calendar-worker.env");
const DEFAULT_WORKER_READY_PATH = `${DEFAULT_WORKER_CREDENTIALS_PATH}.ready`;

function parseOAuthClientJson(value) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("Paste a valid Google OAuth client JSON file."); }
  const client = parsed?.installed || parsed?.web;
  const clientId = typeof client?.client_id === "string" ? client.client_id.trim() : "";
  const clientSecret = typeof client?.client_secret === "string" ? client.client_secret.trim() : "";
  const redirectUris = Array.isArray(client?.redirect_uris) ? client.redirect_uris : [];
  if (!clientId || !clientSecret || !redirectUris.includes("http://127.0.0.1:8765/oauth2callback")) {
    throw new Error("OAuth JSON must contain a client ID, client secret, and the REFAL loopback callback URI.");
  }
  return { GOOGLE_CALENDAR_CLIENT_ID: clientId, GOOGLE_CALENDAR_CLIENT_SECRET: clientSecret };
}

function readWorkerCredentials(filePath = DEFAULT_WORKER_CREDENTIALS_PATH) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && WORKER_CALENDAR_KEYS.includes(match[1])) values[match[1]] = match[2];
  }
  return values;
}

function workerCredentialsReady(filePath = DEFAULT_WORKER_CREDENTIALS_PATH) {
  // Dashboard readiness checks metadata only; it never reads credential contents.
  return fs.existsSync(filePath) && fs.existsSync(`${filePath}.ready`);
}

function saveWorkerCredentials(credentials, filePath = DEFAULT_WORKER_CREDENTIALS_PATH) {
  for (const key of WORKER_CALENDAR_KEYS) {
    if (typeof credentials?.[key] !== "string" || !credentials[key] || /[\r\n]/.test(credentials[key])) {
      throw new Error("Calendar authorization did not return a complete credential set.");
    }
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") secureWindowsPath(directory, true);
  else fs.chmodSync(directory, 0o700);
  fs.writeFileSync(filePath, `${WORKER_CALENDAR_KEYS.map((key) => `${key}=${credentials[key]}`).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    if (process.platform === "win32") secureWindowsPath(filePath, false);
    else fs.chmodSync(filePath, 0o600);
  } catch {
    try { fs.rmSync(filePath, { force: true }); } catch { /* Fail closed; the ready marker is not written. */ }
    throw new Error("Could not restrict access to the worker credential file; authorization was not saved.");
  }
  const readyPath = `${filePath}.ready`;
  fs.writeFileSync(readyPath, "configured\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform === "win32") secureWindowsPath(readyPath, false);
  else fs.chmodSync(readyPath, 0o600);
}

function secureWindowsPath(target, isDirectory) {
  const identity = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
  if (!identity || /[\r\n]/.test(identity)) throw new Error("Could not determine the owner account for the worker credential file.");
  const grant = isDirectory ? `${identity}:(OI)(CI)F` : `${identity}:(F)`;
  execFileSync("icacls.exe", [target, "/inheritance:r", "/grant:r", grant], { encoding: "utf8", windowsHide: true, stdio: "ignore" });
}

function loadWorkerCredentialsIntoEnvironment(filePath = DEFAULT_WORKER_CREDENTIALS_PATH, target = process.env) {
  const credentials = readWorkerCredentials(filePath);
  for (const key of WORKER_CALENDAR_KEYS) if (credentials[key]) target[key] = credentials[key];
  return WORKER_CALENDAR_KEYS.every((key) => Boolean(target[key]));
}

module.exports = { DEFAULT_WORKER_CREDENTIALS_PATH, DEFAULT_WORKER_READY_PATH, WORKER_CALENDAR_KEYS, loadWorkerCredentialsIntoEnvironment, parseOAuthClientJson, readWorkerCredentials, saveWorkerCredentials, secureWindowsPath, workerCredentialsReady };
