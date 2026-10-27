/** Map a list with bounded in-flight work while preserving input order. */
export async function mapWithConcurrency(items, mapper, concurrency = 8) {
  if (!Array.isArray(items)) throw new TypeError("Items must be an array.");
  if (typeof mapper !== "function") throw new TypeError("A mapper function is required.");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("Concurrency must be a positive integer.");

  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
