import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = path.dirname(fileURLToPath(import.meta.url));
const diagnosticPath = path.resolve(dashboardRoot, "..", "dashboard-startup-error.log");
const startupMarker = `REFAL dashboard startup entered: node=${process.version}; portConfigured=${Boolean(process.env.PORT)}\n`;

try {
  fs.appendFileSync(diagnosticPath, startupMarker, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(diagnosticPath, 0o600);
} catch {
  // Keep startup independent of optional diagnostics.
}

try {
  await import("./server.js");
  fs.appendFileSync(diagnosticPath, "REFAL dashboard startup import completed\n", { encoding: "utf8", mode: 0o600 });
} catch (error) {
  let detail = String(error?.stack || error?.message || error || "Unknown dashboard startup error");
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 6) {
      detail = detail.replaceAll(value, "[redacted]");
    }
  }
  const diagnostic = `REFAL dashboard startup failed: ${detail}\n`;
  try {
    fs.appendFileSync(diagnosticPath, diagnostic, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(diagnosticPath, 0o600);
  } catch {
    // Passenger stderr remains a fallback if the private diagnostic file is unavailable.
  }
  console.error(diagnostic.trim());
  process.exitCode = 1;
}
