import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRateLimit } from "./agentRateLimit.js";

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test("dashboard agent requests are limited per signed-in user", () => {
  const limit = createAgentRateLimit({ limit: 1 });
  let nextCalls = 0;
  const first = mockResponse();
  limit({ dashboardUser: { id: "admin-a" } }, first, () => { nextCalls += 1; });
  const blocked = mockResponse();
  limit({ dashboardUser: { id: "admin-a" } }, blocked, () => { nextCalls += 1; });
  const other = mockResponse();
  limit({ dashboardUser: { id: "admin-b" } }, other, () => { nextCalls += 1; });

  assert.equal(nextCalls, 2);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers["Retry-After"]) > 0);
  assert.equal(other.statusCode, 200);
});

test("dashboard agent rate limits reset after their window", () => {
  let timestamp = 1000;
  const limit = createAgentRateLimit({ limit: 1, windowMs: 100, now: () => timestamp });
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };
  limit({ ip: "127.0.0.1" }, mockResponse(), next);
  const blocked = mockResponse();
  limit({ ip: "127.0.0.1" }, blocked, next);
  assert.equal(blocked.statusCode, 429);
  timestamp += 101;
  limit({ ip: "127.0.0.1" }, mockResponse(), next);
  assert.equal(nextCalls, 2);
});
