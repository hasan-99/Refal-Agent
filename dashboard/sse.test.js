import assert from "node:assert/strict";
import { test } from "node:test";
import { readSseData } from "./src/sse.js";

function streamFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });
}

test("SSE parser joins data split across transport chunks and handles CRLF frames", async () => {
  const body = streamFrom([
    "data: {\"type\":\"tok",
    "en\",\"token\":\"A\"}\r\n\r",
    "\ndata: {\"type\":\"token\",\"token\":\"B\"}\r\n\r\n"
  ]);
  const events = [];
  for await (const data of readSseData(body)) events.push(JSON.parse(data));
  assert.deepEqual(events, [
    { type: "token", token: "A" },
    { type: "token", token: "B" }
  ]);
});

test("SSE parser supports multiple data lines and ignores malformed frames", async () => {
  const events = [];
  for await (const data of readSseData(streamFrom([
    ": keepalive\n\ndata: not-json\n\ndata: {\"type\":\n",
    "data: \"token\",\"token\":\"hello\"}\n\n"
  ]))) {
    try { events.push(JSON.parse(data)); } catch { /* Ignore malformed upstream events. */ }
  }
  assert.deepEqual(events, [{ type: "token", token: "hello" }]);
});

test("SSE parser yields a final event without a trailing blank line", async () => {
  const events = [];
  for await (const data of readSseData(streamFrom(["data: {\"type\":\"complete\"}"]))) events.push(JSON.parse(data));
  assert.deepEqual(events, [{ type: "complete" }]);
});

test("SSE parser rejects oversized unterminated frames", async () => {
  const body = streamFrom([`data: ${"x".repeat(1_000_001)}`]);
  await assert.rejects(async () => {
    for await (const _data of readSseData(body)) { /* consume */ }
  }, /oversized event/);
});
