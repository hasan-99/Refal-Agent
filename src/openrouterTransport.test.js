const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");

const {
  fetchOpenRouter,
  resolveProxyUrl,
  isCorporateProxyTransportEnabled,
  defaultCurlRunner,
  buildCurlConfigFile,
  parseCurlOutput
} = require("./openrouterTransport");

const PROXY_ENV_KEYS = ["OPENROUTER_CORPORATE_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];

function withProxyEnv(overrides, fn) {
  const saved = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) {
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of PROXY_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test("resolveProxyUrl: no proxy env configured returns undefined", () => withProxyEnv({}, () => {
  assert.equal(resolveProxyUrl("https://openrouter.ai/api/v1/chat/completions"), undefined);
}));

test("resolveProxyUrl: falls back to HTTP_PROXY when HTTPS_PROXY is unset", () => withProxyEnv(
  { HTTP_PROXY: "http://proxy.example:8080" },
  () => {
    assert.equal(resolveProxyUrl("https://openrouter.ai/x"), "http://proxy.example:8080");
  }
));

test("resolveProxyUrl: NO_PROXY suffix match disables the proxy for that host", () => withProxyEnv(
  { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "example.com,openrouter.ai" },
  () => {
    assert.equal(resolveProxyUrl("https://openrouter.ai/x"), undefined);
  }
));

test("resolveProxyUrl: NO_PROXY wildcard disables every host", () => withProxyEnv(
  { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "*" },
  () => {
    assert.equal(resolveProxyUrl("https://openrouter.ai/x"), undefined);
  }
));

test("isCorporateProxyTransportEnabled: requires the explicit opt-in flag even when a proxy is configured", () => withProxyEnv(
  { HTTPS_PROXY: "http://proxy.example:8080" },
  () => {
    assert.equal(isCorporateProxyTransportEnabled("https://openrouter.ai/x"), false);
  }
));

test("isCorporateProxyTransportEnabled: true only with flag + proxy both present", () => withProxyEnv(
  { OPENROUTER_CORPORATE_PROXY: "1", HTTPS_PROXY: "http://proxy.example:8080" },
  () => {
    assert.equal(isCorporateProxyTransportEnabled("https://openrouter.ai/x"), true);
  }
));

test("fetchOpenRouter: default (no flag) calls the global fetch, never the curl runner — existing mocked tests are unaffected", () => withProxyEnv(
  { HTTPS_PROXY: "http://proxy.example:8080" }, // proxy present (true on this machine) but flag absent
  async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    let curlCalled = false;
    global.fetch = async (url, options) => {
      fetchCalled = true;
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(options.method, "POST");
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
    };
    try {
      const response = await fetchOpenRouter(
        "https://openrouter.ai/api/v1/chat/completions",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 5000 },
        { curlRunner: async () => { curlCalled = true; } }
      );
      assert.equal(response.ok, true);
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(fetchCalled, true);
    assert.equal(curlCalled, false);
  }
));

test("fetchOpenRouter: with the explicit opt-in flag + proxy, routes through the injected curl runner and never calls fetch", () => withProxyEnv(
  { OPENROUTER_CORPORATE_PROXY: "1", HTTPS_PROXY: "http://occyproxy.example:8080" },
  async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; throw new Error("fetch must not be called when the corporate proxy transport is enabled"); };
    let seenArgs;
    try {
      const response = await fetchOpenRouter(
        "https://openrouter.ai/api/v1/chat/completions",
        { method: "POST", headers: { Authorization: "Bearer test-key" }, body: '{"a":1}' },
        { curlRunner: async (args) => { seenArgs = args; return { ok: true, status: 200, json: async () => ({ ok: true }) }; } }
      );
      assert.equal(response.ok, true);
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(fetchCalled, false);
    assert.equal(seenArgs.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(seenArgs.method, "POST");
    assert.equal(seenArgs.proxyUrl, "http://occyproxy.example:8080");
    assert.equal(seenArgs.body, '{"a":1}');
    assert.equal(seenArgs.headers.Authorization, "Bearer test-key");
  }
));

test("fetchOpenRouter: NO_PROXY for the target host falls back to fetch even with the flag set", () => withProxyEnv(
  { OPENROUTER_CORPORATE_PROXY: "1", HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "openrouter.ai" },
  async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
    try {
      await fetchOpenRouter("https://openrouter.ai/x", { method: "GET" }, { curlRunner: async () => { throw new Error("must not be called"); } });
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(fetchCalled, true);
  }
));

test("parseCurlOutput: splits the trailing status marker from the real response body", () => {
  const { bodyText, status } = parseCurlOutput('{"choices":[{"message":{"content":"hi"}}]}\n__OPENROUTER_PROXY_CURL_STATUS__:200');
  assert.equal(status, 200);
  assert.equal(JSON.parse(bodyText).choices[0].message.content, "hi");
});

test("parseCurlOutput: throws when the marker is missing (treated as an infra failure upstream, never a fabricated 200)", () => {
  assert.throws(() => parseCurlOutput("no marker here"), /status marker/);
});

test("parseCurlOutput: throws on a non-numeric status", () => {
  assert.throws(() => parseCurlOutput("body\n__OPENROUTER_PROXY_CURL_STATUS__:oops"), /invalid HTTP status/);
});

test("buildCurlConfigFile: writes NTLM directives, the resolved proxy, and headers — never the OpenRouter URL hardcoded, and cleans up is the caller's job", async () => {
  const file = await buildCurlConfigFile({
    url: "https://openrouter.ai/api/v1/chat/completions",
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    proxyUrl: "http://occyproxy.example:8080",
    timeoutMs: 9000
  });
  try {
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, /proxy-ntlm/);
    assert.match(content, /proxy-user = ":"/);
    assert.match(content, /proxy = "http:\/\/occyproxy\.example:8080"/);
    assert.match(content, /request = "POST"/);
    assert.match(content, /max-time = 9/);
    assert.match(content, /header = "Authorization: Bearer test-secret"/);
    assert.match(content, /data-binary = @-/);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

// Fakes child_process.spawn end-to-end so the full defaultCurlRunner path
// (config file -> process -> stdout parsing -> temp-file cleanup) is proven
// without ever invoking the real curl.exe or the real corporate network.
function fakeSpawnEmitting({ stdout = "", stderr = "", exitCode = 0 }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode);
    });
    return child;
  };
}

test("defaultCurlRunner: fake spawn returns a fetch-Response-shaped success result and removes its temp config dir", async () => {
  const spawnImpl = fakeSpawnEmitting({ stdout: '{"choices":[{"message":{"content":"ok"}}]}\n__OPENROUTER_PROXY_CURL_STATUS__:200' });
  let capturedDir;
  const originalMkdtemp = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async (...args) => {
    const dir = await originalMkdtemp(...args);
    capturedDir = dir;
    return dir;
  };
  try {
    const result = await defaultCurlRunner(
      { url: "https://openrouter.ai/api/v1/chat/completions", method: "POST", headers: { Authorization: "Bearer x" }, body: "{}", proxyUrl: "http://occyproxy.example:8080", timeoutMs: 5000 },
      { spawnImpl, platform: "win32" }
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { choices: [{ message: { content: "ok" } }] });
  } finally {
    fs.promises.mkdtemp = originalMkdtemp;
  }
  assert.ok(capturedDir);
  assert.equal(fs.existsSync(capturedDir), false, "temp config dir must be removed after the call");
});

test("defaultCurlRunner: a non-zero curl exit becomes a thrown error, never a fabricated success", async () => {
  const spawnImpl = fakeSpawnEmitting({ stderr: "curl: (56) connection reset", exitCode: 56 });
  await assert.rejects(
    defaultCurlRunner(
      { url: "https://openrouter.ai/x", method: "GET", headers: {}, proxyUrl: "http://occyproxy.example:8080" },
      { spawnImpl, platform: "win32" }
    ),
    /curl exited with code 56/
  );
});

test("defaultCurlRunner: refuses to run on a non-Windows platform instead of silently skipping NTLM", async () => {
  await assert.rejects(
    defaultCurlRunner(
      { url: "https://openrouter.ai/x", method: "GET", headers: {}, proxyUrl: "http://occyproxy.example:8080" },
      { spawnImpl: fakeSpawnEmitting({}), platform: "linux" }
    ),
    /Windows only/
  );
});
