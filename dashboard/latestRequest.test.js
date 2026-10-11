import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLatestRequestGate } from "./latestRequest.js";

test("a late response for the previous dashboard tab cannot replace current data", () => {
  const gate = createLatestRequestGate();
  const offersRequest = gate.begin();
  const propertiesRequest = gate.begin();
  assert.equal(gate.isCurrent(offersRequest), false);
  assert.equal(gate.isCurrent(propertiesRequest), true);
});

test("changing tabs invalidates a pending load immediately", () => {
  const gate = createLatestRequestGate();
  const pendingRequest = gate.begin();
  gate.invalidate();
  assert.equal(gate.isCurrent(pendingRequest), false);
});

test("commercial data loader guards success, failure, and loading state with the latest request", () => {
  const source = readFileSync(new URL("./src/DynamicData.jsx", import.meta.url), "utf8");
  assert.match(source, /createLatestRequestGate/);
  assert.match(source, /if\s*\(!requestGate\.isCurrent\(requestId\)\)\s*return/);
  assert.match(source, /requestGate\.invalidate\(\)/);
  assert.match(source, /finally\s*\{\s*if\s*\(requestGate\.isCurrent\(requestId\)\)/);
});
