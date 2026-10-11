#!/usr/bin/env node
// The dashboard-managed worker loads its own ignored env files. The dashboard
// process never needs calendar credential values in its environment.
const path = require("node:path");
const { loadProjectEnv } = require("../src/env.js");
const { loadWorkerCredentialsIntoEnvironment } = require("./googleCalendarCredentialStore.js");

const root = path.resolve(__dirname, "..");
loadProjectEnv(root);
for (const key of ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN", "GOOGLE_CALENDAR_CLIENT_EMAIL", "GOOGLE_CALENDAR_PRIVATE_KEY"]) delete process.env[key];
loadWorkerCredentialsIntoEnvironment();
require("../src/bot.js");
