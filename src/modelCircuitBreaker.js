// Process-local circuit breaker for model-provider requests. It keeps only a
// small failure counter and timestamps; it never stores request/response data.
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED"
]);

function isTransientTransportError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return true;
  const code = String(error?.code || "").toUpperCase();
  if (TRANSIENT_TRANSPORT_CODES.has(code)) return true;
  const causeCode = String(error?.cause?.code || "").toUpperCase();
  if (TRANSIENT_TRANSPORT_CODES.has(causeCode)) return true;
  // openrouterTransport's Windows proxy runner currently exposes curl's exit
  // code in a stable message rather than an error.code property. Count only
  // connection/resolve/TLS transport loss and timeout codes; e.g. malformed
  // URL (3) and certificate validation (60) remain non-transient.
  return /^curl exited with code (?:5|6|7|28|35|52|55|56):/iu.test(String(error?.message || ""));
}

function createModelCircuitBreaker({
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now
} = {}) {
  const threshold = Number.isInteger(failureThreshold) && failureThreshold > 0 ? failureThreshold : DEFAULT_FAILURE_THRESHOLD;
  const cooldown = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : DEFAULT_COOLDOWN_MS;
  let failures = 0;
  let openUntil = 0;
  let probeInFlight = false;
  let generation = 0;

  function openError() {
    const error = new Error("Model provider circuit is open.");
    error.code = "MODEL_PROVIDER_CIRCUIT_OPEN";
    error.status = 503;
    return error;
  }

  function failed() {
    failures = Math.min(threshold, failures + 1);
    if (probeInFlight || failures >= threshold) {
      // Invalidate in-flight requests only when the breaker actually changes
      // state. A single transient blip below threshold must not make a later
      // successful concurrent request invisible, or intermittent failures
      // accumulate across successful provider calls.
      generation += 1;
      openUntil = now() + cooldown;
      probeInFlight = false;
    }
  }

  async function run(operation) {
    const time = now();
    const probing = openUntil > 0 && time >= openUntil;
    if (openUntil > time || (probing && probeInFlight)) throw openError();
    if (probing) probeInFlight = true;
    const requestGeneration = generation;

    try {
      const response = await operation();
      const status = Number(response?.status);
      const ok = response?.ok === true || (Number.isFinite(status) && status >= 200 && status < 300);
      if (ok) {
        if (requestGeneration === generation && (probing ? probeInFlight : openUntil === 0)) {
          failures = 0;
          openUntil = 0;
          probeInFlight = false;
          generation += 1;
        }
      } else if (status === 408 || status === 429 || status >= 500) {
        failed();
      } else if (probing) {
        // A probe that receives an unexpected non-success response is not
        // proof of recovery; give the provider another bounded cooldown.
        if (requestGeneration === generation && probeInFlight) {
          openUntil = now() + cooldown;
          probeInFlight = false;
          generation += 1;
        }
      }
      return response;
    } catch (error) {
      if (isTransientTransportError(error)) {
        failed();
      } else if (probing && requestGeneration === generation && probeInFlight) {
        // Do not count a local/programming error as provider failure, but keep
        // the circuit open briefly so a broken probe cannot cause a hot loop.
        openUntil = now() + cooldown;
        probeInFlight = false;
        generation += 1;
      }
      throw error;
    }
  }

  function snapshot() {
    return Object.freeze({ failures, openUntil, probeInFlight });
  }

  return Object.freeze({ run, snapshot });
}

const modelProviderCircuit = createModelCircuitBreaker();

module.exports = { createModelCircuitBreaker, modelProviderCircuit, isTransientTransportError };
