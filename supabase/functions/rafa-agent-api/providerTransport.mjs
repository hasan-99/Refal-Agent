/**
 * Bound the full provider exchange, including reading the response body. Edge
 * requests otherwise wait on an upstream that has accepted the connection but
 * never finishes its response, consuming a function invocation indefinitely.
 */
export class ProviderTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`AI provider request exceeded ${timeoutMs}ms.`);
    this.name = "ProviderTimeoutError";
  }
}

export async function fetchJsonWithTimeout(url, init, {
  timeoutMs = 20_000,
  fetchImpl = fetch
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number.");
  }

  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(new ProviderTimeoutError(timeoutMs));
      reject(new ProviderTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const request = Promise.resolve().then(async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      return { response, body };
    });
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}
