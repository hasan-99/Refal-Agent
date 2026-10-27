import test from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "./mapWithConcurrency.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mapWithConcurrency caps simultaneous work and preserves result order", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(value % 2 ? 1 : 4);
    inFlight -= 1;
    return value * 2;
  }, 3);

  assert.equal(peak, 3);
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12]);
});

test("mapWithConcurrency propagates failures and validates its contract", async () => {
  await assert.rejects(mapWithConcurrency([1, 2, 3], async (value) => {
    if (value === 2) throw new Error("read failed");
    return value;
  }), /read failed/);
  await assert.rejects(mapWithConcurrency({}, () => {}), /Items must be an array/);
  await assert.rejects(mapWithConcurrency([], null), /mapper function/);
  await assert.rejects(mapWithConcurrency([], () => {}, 0), /positive integer/);
});
