import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDashboardEnv, stripWorkerCalendarCredentials } from "./dashboardEnv.js";

test("dashboard environment strips inherited worker keys and never loads them from env files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refal-dashboard-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, ".env.rafa");
  fs.writeFileSync(envFile, [
    "DASHBOARD_PORT=8787",
    "GOOGLE_CALENDAR_CLIENT_ID=file-client-id",
    "GOOGLE_CALENDAR_CLIENT_SECRET=file-client-secret",
    "GOOGLE_CALENDAR_REFRESH_TOKEN=file-refresh-token",
    "GOOGLE_CALENDAR_PRIVATE_KEY=file-private-key"
  ].join("\n"));
  const env = { GOOGLE_CALENDAR_CLIENT_ID: "inherited-id", GOOGLE_CALENDAR_CLIENT_SECRET: "inherited-secret", GOOGLE_CALENDAR_REFRESH_TOKEN: "inherited-refresh" };
  stripWorkerCalendarCredentials(env);
  loadDashboardEnv(envFile, env);
  assert.deepEqual(env, { DASHBOARD_PORT: "8787" });
});
