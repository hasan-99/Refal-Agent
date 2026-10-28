import test from "node:test";
import assert from "node:assert/strict";
import { formatUsageUsd } from "./src/usageDisplay.js";

test("usage currency uses readable grouping and keeps meaningful sub-cent precision", () => {
  assert.equal(formatUsageUsd(1234.5), "$1,234.50");
  assert.equal(formatUsageUsd(0.07158934), "$0.071589");
  assert.equal(formatUsageUsd(0.00000123), "$0.00000123");
  assert.equal(formatUsageUsd(Number.NaN), "Unavailable");
});
