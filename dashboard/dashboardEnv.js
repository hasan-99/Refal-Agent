import fs from "node:fs";

export const WORKER_ONLY_CALENDAR_KEYS = Object.freeze([
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_CLIENT_EMAIL",
  "GOOGLE_CALENDAR_PRIVATE_KEY"
]);

export function stripWorkerCalendarCredentials(target = process.env) {
  for (const key of WORKER_ONLY_CALENDAR_KEYS) delete target[key];
  return target;
}

export function loadDashboardEnv(filePath, target = process.env) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key || WORKER_ONLY_CALENDAR_KEYS.includes(key)) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (target[key] === undefined) target[key] = value;
  }
}
