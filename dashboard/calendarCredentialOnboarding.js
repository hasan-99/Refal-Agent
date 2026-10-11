import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

const WORKER_SECRET_KEYS = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN", "GOOGLE_CALENDAR_CLIENT_EMAIL", "GOOGLE_CALENDAR_PRIVATE_KEY"];

export function createCalendarCredentialOnboarding({ botRoot, spawn = nodeSpawn, env = process.env, onConfigured = async () => null }) {
  const helper = path.join(botRoot, "scripts", "dashboardGoogleCalendarWorker.js");
  let authChild = null;
  let state = "not_configured";

  function start() {
    if (authChild) throw new Error("A calendar authorization is already in progress.");
    const setupToken = randomBytes(32).toString("base64url");
    const helperEnv = { ...env };
    for (const key of WORKER_SECRET_KEYS) delete helperEnv[key];
    const child = spawn(process.execPath, [helper, "authorize"], {
      cwd: botRoot,
      env: helperEnv,
      stdio: ["pipe", "pipe", "ignore"]
    });
    authChild = child;
    state = "awaiting_credentials";
    let buffer = "";
    let settled = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          state = "error";
          child.kill();
          authChild = null;
          reject(new Error("Calendar authorization helper did not start in time."));
        }
      }, 10000);
      const finishStart = (error, readyToken) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve({ submissionUrl: "http://127.0.0.1:8765/credentials", setupToken: readyToken, status: "awaiting_credentials" });
      };
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "setup_ready" && event.token === setupToken) finishStart(null, event.token);
          else if (event.type === "authorization_started") state = "awaiting_consent";
          else if (event.type === "error") {
            state = "error";
            if (authChild === child) authChild = null;
            finishStart(new Error(event.message || "Calendar authorization could not start."));
          } else if (event.type === "complete") {
            state = "configured";
            Promise.resolve(onConfigured()).then((result) => {
              state = result?.restarted ? "configured_worker_restarting" : "configured_worker_restart_needed";
            }).catch(() => { state = "configured_worker_restart_needed"; });
          }
        }
      });
      child.once("error", () => {
        state = "error";
        if (authChild === child) authChild = null;
        finishStart(new Error("Calendar authorization helper could not start."));
      });
      child.once("close", (code) => {
        if (authChild === child) authChild = null;
        if (code !== 0 && !state.startsWith("configured")) state = "error";
        if (!settled) finishStart(new Error("Calendar authorization helper stopped before it was ready."));
      });
      child.stdin.end(setupToken);
    });
  }

  function verify(policy) {
    return new Promise((resolve, reject) => {
      const helperEnv = { ...env };
      for (const key of WORKER_SECRET_KEYS) delete helperEnv[key];
      const child = spawn(process.execPath, [helper, "verify"], { cwd: botRoot, env: helperEnv, stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.once("error", () => reject(new Error("Calendar access check could not start.")));
      child.once("close", (code) => {
        const event = output.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
        if (code === 0 && event?.type === "verified" && event.access) resolve(event.access);
        else reject(new Error(event?.type === "error" ? event.message : "Google Calendar access could not be verified."));
      });
      child.stdin.end(JSON.stringify(policy));
    });
  }

  function review(payload) {
    return new Promise((resolve, reject) => {
      const helperEnv = { ...env };
      for (const key of WORKER_SECRET_KEYS) delete helperEnv[key];
      const child = spawn(process.execPath, [helper, "review"], { cwd: botRoot, env: helperEnv, stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.once("error", () => reject(new Error("Calendar appointment action could not start.")));
      child.once("close", (code) => {
        const event = output.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
        if (code === 0 && event?.type === "reviewed" && event.result) resolve(event.result);
        else reject(new Error(event?.type === "error" ? event.message : "Calendar appointment action failed. Check access and retry."));
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }

  return { start, verify, review, get status() { return state; } };
}
