const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createModelCircuitBreaker } = require("./modelCircuitBreaker");

test("model circuit opens after bounded transient failures and rejects provider work while open", async () => {
  let now = 100;
  let calls = 0;
  const circuit = createModelCircuitBreaker({ failureThreshold: 2, cooldownMs: 50, now: () => now });
  const unavailable = () => circuit.run(async () => {
    calls += 1;
    return { ok: false, status: 503 };
  });

  await unavailable();
  await unavailable();
  assert.equal(circuit.snapshot().failures, 2);
  assert.equal(circuit.snapshot().openUntil, 150);
  await assert.rejects(() => circuit.run(async () => { calls += 1; }), { code: "MODEL_PROVIDER_CIRCUIT_OPEN" });
  assert.equal(calls, 2, "open state must fail before contacting the provider");
});

test("one half-open probe is allowed; successful probe closes and resets the circuit", async () => {
  let now = 0;
  const circuit = createModelCircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => now });
  await circuit.run(async () => ({ ok: false, status: 429 }));
  now = 10;

  let releaseProbe;
  const probe = circuit.run(() => new Promise((resolve) => { releaseProbe = resolve; }));
  await Promise.resolve();
  assert.equal(circuit.snapshot().probeInFlight, true);
  await assert.rejects(() => circuit.run(async () => ({ ok: true, status: 200 })), { code: "MODEL_PROVIDER_CIRCUIT_OPEN" });
  releaseProbe({ ok: true, status: 200 });
  await probe;

  assert.deepEqual(circuit.snapshot(), { failures: 0, openUntil: 0, probeInFlight: false });
  const recovered = await circuit.run(async () => ({ ok: true, status: 200 }));
  assert.equal(recovered.status, 200);
});

test("network errors count as transient failures and rethrow unchanged for safe caller fallback", async () => {
  const circuit = createModelCircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
  const providerError = Object.assign(new Error("network unavailable"), { code: "ECONNRESET" });
  await assert.rejects(() => circuit.run(async () => { throw providerError; }), (error) => error === providerError);
  assert.equal(circuit.snapshot().failures, 1);
  assert.ok(circuit.snapshot().openUntil > Date.now());
});

test("a timeout while reading the provider response body counts as a transient failure", async () => {
  const circuit = createModelCircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
  const bodyTimeout = Object.assign(new Error("response body timed out"), { name: "TimeoutError" });
  const readCompleteProviderResponse = async () => {
    const response = await Promise.resolve({ ok: true, status: 200, json: async () => { throw bodyTimeout; } });
    return { response, body: await response.json() };
  };

  await assert.rejects(() => circuit.run(readCompleteProviderResponse), (error) => error === bodyTimeout);
  assert.equal(circuit.snapshot().failures, 1);
  assert.ok(circuit.snapshot().openUntil > Date.now());
  await assert.rejects(() => circuit.run(readCompleteProviderResponse), { code: "MODEL_PROVIDER_CIRCUIT_OPEN" });
});

test("local and programming errors propagate unchanged without counting as provider failures", async () => {
  const circuit = createModelCircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
  const programmingError = new TypeError("Cannot read properties of undefined");
  await assert.rejects(() => circuit.run(async () => { throw programmingError; }), (error) => error === programmingError);
  assert.deepEqual(circuit.snapshot(), { failures: 0, openUntil: 0, probeInFlight: false });

  const curlConfigError = new Error("curl exited with code 60: certificate verify failed");
  await assert.rejects(() => circuit.run(async () => { throw curlConfigError; }), (error) => error === curlConfigError);
  assert.deepEqual(circuit.snapshot(), { failures: 0, openUntil: 0, probeInFlight: false });
});

test("an older in-flight success cannot close a circuit opened by a newer failure", async () => {
  let now = 0;
  const circuit = createModelCircuitBreaker({ failureThreshold: 1, cooldownMs: 50, now: () => now });
  let releaseOlderRequest;
  const olderRequest = circuit.run(() => new Promise((resolve) => { releaseOlderRequest = resolve; }));
  await Promise.resolve();

  await circuit.run(async () => ({ ok: false, status: 503 }));
  assert.equal(circuit.snapshot().openUntil, 50);
  releaseOlderRequest({ ok: true, status: 200 });
  await olderRequest;

  assert.equal(circuit.snapshot().openUntil, 50, "stale success must not reset the open circuit");
  await assert.rejects(() => circuit.run(async () => ({ ok: true, status: 200 })), { code: "MODEL_PROVIDER_CIRCUIT_OPEN" });
});

test("a successful concurrent provider call resets a sub-threshold transient failure", async () => {
  let now = 0;
  const circuit = createModelCircuitBreaker({ failureThreshold: 2, cooldownMs: 50, now: () => now });
  let releaseSuccess;
  const successfulRequest = circuit.run(() => new Promise((resolve) => { releaseSuccess = resolve; }));
  await Promise.resolve();

  await circuit.run(async () => ({ ok: false, status: 503 }));
  assert.equal(circuit.snapshot().failures, 1);
  releaseSuccess({ ok: true, status: 200 });
  await successfulRequest;

  assert.deepEqual(circuit.snapshot(), { failures: 0, openUntil: 0, probeInFlight: false });
  await circuit.run(async () => ({ ok: false, status: 503 }));
  assert.equal(circuit.snapshot().failures, 1, "a recovered provider should not trip from a prior isolated failure");
});

test("non-transient HTTP errors do not trip a closed circuit", async () => {
  const circuit = createModelCircuitBreaker({ failureThreshold: 2 });
  await circuit.run(async () => ({ ok: false, status: 401 }));
  assert.deepEqual(circuit.snapshot(), { failures: 0, openUntil: 0, probeInFlight: false });
});
