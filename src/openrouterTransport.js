// Shared OpenRouter HTTP transport for ai.js / agentDecision.js /
// benchmarkEvaluator.js.
//
// Root cause (confirmed, not guessed): this machine's corporate proxy
// (`HTTPS_PROXY`/`HTTP_PROXY` = occyproxy.odysseycs.com:8080, already set at
// the OS/user level for every process) requires NTLM authentication. Node's
// `fetch()` has no NTLM support and no proxy support at all — a direct
// `fetch()` to openrouter.ai from behind this proxy does not even reach the
// proxy's auth challenge, it just hangs until the OS-level connect timeout.
// `curl.exe` (shipped by Windows since 10 1803, also present via Git) DOES
// authenticate transparently against this proxy using the current Windows
// login via SSPI (`--proxy-ntlm -U :` — no stored username/password, no
// secret ever written to source or argv), confirmed with a real 200 response
// from https://openrouter.ai/api/v1/models.
//
// This module changes nothing by default: `fetchOpenRouter` calls the plain
// global `fetch` unless BOTH an explicit opt-in flag (`OPENROUTER_CORPORATE_PROXY`)
// and a proxy URL are present. Production (no flag set) and the existing unit
// test suite (which mocks `global.fetch` directly and never sets the flag)
// are both unaffected.
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CURL_STATUS_MARKER = "__OPENROUTER_PROXY_CURL_STATUS__";
const DEFAULT_TIMEOUT_MS = 20000;

function truthyFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function parseNoProxyList(value) {
  return String(value || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function hostnameMatchesNoProxy(hostname, noProxyEntries) {
  const host = String(hostname || "").toLowerCase();
  return noProxyEntries.some((entry) => {
    if (entry === "*") return true;
    const normalized = entry.startsWith(".") ? entry.slice(1) : entry;
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

// Mirrors standard HTTPS_PROXY/HTTP_PROXY/NO_PROXY resolution (case-insensitive
// env names, NO_PROXY suffix matching); does not invent a new config surface.
function resolveProxyUrl(targetUrl) {
  let hostname;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return undefined;
  }
  const noProxyEntries = parseNoProxyList(process.env.NO_PROXY || process.env.no_proxy);
  if (hostnameMatchesNoProxy(hostname, noProxyEntries)) return undefined;
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || undefined;
}

// Explicit opt-in only: a corporate HTTPS_PROXY/HTTP_PROXY being present in
// the environment (true on this machine for every process, test runs
// included) must never by itself change transport — only setting
// OPENROUTER_CORPORATE_PROXY=1 does.
function isCorporateProxyTransportEnabled(targetUrl) {
  return truthyFlag(process.env.OPENROUTER_CORPORATE_PROXY) && Boolean(resolveProxyUrl(targetUrl));
}

function quoteConfigValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// curl's `-K` config-file form (one directive per line, no leading `--`) is
// used instead of argv flags so the Authorization header (and the body) never
// appear in the process argument list, which other local processes/users can
// read (e.g. Task Manager, wmic) — argv is not an acceptable place for a
// bearer token even on a single-user machine.
async function buildCurlConfigFile({ url, method, headers, proxyUrl, timeoutMs }) {
  const lines = [
    `url = ${quoteConfigValue(url)}`,
    `request = ${quoteConfigValue(method || "GET")}`,
    "silent",
    "show-error",
    `max-time = ${Math.max(1, Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000))}`,
    `proxy = ${quoteConfigValue(proxyUrl)}`,
    "proxy-ntlm",
    `proxy-user = ${quoteConfigValue(":")}`,
    "data-binary = @-",
    // Deliberately NOT built via quoteConfigValue: curl's config-file quoting
    // only turns the two-character sequence `\n` into a real newline when it
    // is literally backslash-n in the file — an actual embedded newline
    // character breaks curl's line-based -K parser ("error encountered when
    // reading a file"), confirmed by reproduction.
    `write-out = "\\n${CURL_STATUS_MARKER}:%{http_code}"`
  ];
  for (const [key, value] of Object.entries(headers || {})) {
    lines.push(`header = ${quoteConfigValue(`${key}: ${value}`)}`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "refal-openrouter-curl-"));
  const file = path.join(dir, "request.conf");
  await fs.writeFile(file, lines.join("\n"), { mode: 0o600 });
  return file;
}

function parseCurlOutput(raw) {
  const markerKey = `${CURL_STATUS_MARKER}:`;
  const markerIndex = String(raw || "").lastIndexOf(markerKey);
  if (markerIndex === -1) throw new Error("curl response was missing the expected status marker.");
  const bodyText = raw.slice(0, markerIndex).replace(/\n$/, "");
  const status = Number.parseInt(raw.slice(markerIndex + markerKey.length).trim(), 10);
  if (!Number.isFinite(status)) throw new Error("curl response had an invalid HTTP status code.");
  return { bodyText, status };
}

async function execCurl({ configFile, body, spawnImpl = spawn, curlPath = "curl" }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(curlPath, ["-K", configFile], { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, Buffer.from(chunk)]); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curl exited with code ${code}: ${stderr.trim().slice(0, 300) || "(no stderr)"}`));
        return;
      }
      resolve(stdout.toString("utf8"));
    });
    child.stdin.end(body ?? "");
  });
}

// The only implementation of the proxy path. Returns a minimal
// fetch-Response-shaped object (`ok`/`status`/`json()`) — the only members
// ai.js/agentDecision.js/benchmarkEvaluator.js actually read.
async function defaultCurlRunner({ url, method, headers, body, proxyUrl, timeoutMs }, { spawnImpl, platform = process.platform } = {}) {
  if (platform !== "win32") {
    throw new Error("Corporate proxy NTLM transport is implemented for Windows only (curl.exe + SSPI); no NTLM-capable transport is configured for this platform.");
  }
  if (!proxyUrl) throw new Error("No proxy URL resolved for the corporate proxy transport.");
  const configFile = await buildCurlConfigFile({ url, method, headers, proxyUrl, timeoutMs });
  try {
    const raw = await execCurl({ configFile, body, spawnImpl });
    const { bodyText, status } = parseCurlOutput(raw);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(bodyText)
    };
  } finally {
    await fs.rm(path.dirname(configFile), { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchOpenRouter(url, options = {}, { curlRunner = defaultCurlRunner } = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  if (!isCorporateProxyTransportEnabled(url)) return fetch(url, fetchOptions);
  const proxyUrl = resolveProxyUrl(url);
  return curlRunner({
    url,
    method: fetchOptions.method || "GET",
    headers: fetchOptions.headers || {},
    body: fetchOptions.body,
    proxyUrl,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS
  });
}

module.exports = {
  fetchOpenRouter,
  resolveProxyUrl,
  isCorporateProxyTransportEnabled,
  defaultCurlRunner,
  buildCurlConfigFile,
  parseCurlOutput,
  execCurl
};
