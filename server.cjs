const fs = require("node:fs");
const path = require("node:path");

const diagnosticPath = path.join(__dirname, "dashboard-startup-error.log");

function writeDiagnostic(message) {
  try {
    fs.appendFileSync(diagnosticPath, message, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(diagnosticPath, 0o600);
  } catch {
    // Keep startup independent of optional diagnostics.
  }
}

writeDiagnostic(`REFAL dashboard startup entered: node=${process.version}; portConfigured=${Boolean(process.env.PORT)}\n`);

import("./dashboard/server.js").then(() => {
  writeDiagnostic("REFAL dashboard startup import completed\n");
}).catch((error) => {
  let detail = String(error?.stack || error?.message || error || "Unknown dashboard startup error");
  for (const value of Object.values(process.env)) {
    if (value && value.length >= 6) detail = detail.replaceAll(value, "[redacted]");
  }
  writeDiagnostic(`REFAL dashboard startup failed: ${detail}\n`);
  console.error(`REFAL dashboard startup failed: ${detail}`);
  process.exitCode = 1;
});
