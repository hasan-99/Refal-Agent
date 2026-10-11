"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMessageExecutor, parseMessageQueueLimit } = require("./messageConcurrency");

test("queue limit configuration preserves zero and rejects malformed or unsafe values", () => {
  assert.equal(parseMessageQueueLimit(undefined), 200);
  assert.equal(parseMessageQueueLimit(""), 200);
  assert.equal(parseMessageQueueLimit("0"), 0);
  assert.equal(parseMessageQueueLimit("2000"), 2000);
  for (const value of ["-1", "2001", "2.5", "NaN", "unbounded"]) {
    assert.throws(() => parseMessageQueueLimit(value), /integer from 0 to 2000/);
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("serializes messages from one contact in FIFO order", async () => {
  const executor = createMessageExecutor({ concurrency: 3, maxQueue: 5 });
  const gate = deferred();
  const seen = [];
  const first = executor.run("a", async () => { seen.push("first:start"); await gate.promise; seen.push("first:end"); });
  const second = executor.run("a", async () => { seen.push("second"); });
  await Promise.resolve();
  assert.deepEqual(seen, ["first:start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["first:start", "first:end", "second"]);
});

test("serializes legacy and current phone JID spellings for the same contact", async () => {
  const executor = createMessageExecutor({ concurrency: 2, maxQueue: 2 });
  const gate = deferred();
  const seen = [];
  const first = executor.run("15551234567@s.whatsapp.net", async () => {
    seen.push("current:start");
    await gate.promise;
    seen.push("current:end");
  });
  const second = executor.run("15551234567@c.us", async () => { seen.push("legacy"); });

  await Promise.resolve();
  assert.deepEqual(seen, ["current:start"], "the alias must not run concurrently as a separate contact");
  assert.equal(executor.getStats().activeContacts, 1);
  assert.equal(executor.getStats().queued, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["current:start", "current:end", "legacy"]);
});

test("runs different contacts concurrently but never exceeds the configured limit", async () => {
  const executor = createMessageExecutor({ concurrency: 2, maxQueue: 5 });
  const gates = [deferred(), deferred(), deferred()];
  let peak = 0;
  let running = 0;
  const tasks = ["a", "b", "c"].map((key, i) => executor.run(key, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await gates[i].promise;
    running -= 1;
  }));
  await Promise.resolve();
  assert.equal(executor.getStats().active, 2);
  assert.equal(executor.getStats().queued, 1);
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.getStats().active, 2);
  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test("rejects overload without growing beyond the bounded waiting queue", async () => {
  const executor = createMessageExecutor({ concurrency: 1, maxQueue: 1 });
  const gate = deferred();
  const first = executor.run("a", () => gate.promise);
  await Promise.resolve();
  const queued = executor.run("b", async () => {});
  await assert.rejects(executor.run("c", async () => {}), (error) => error.code === "MESSAGE_QUEUE_FULL");
  assert.equal(executor.getStats().queued, 1);
  gate.resolve();
  await Promise.all([first, queued]);
});

test("zero waiting capacity still admits immediately runnable work and rejects only work that must wait", async () => {
  const executor = createMessageExecutor({ concurrency: 1, maxQueue: 0 });
  const gate = deferred();
  const first = executor.run("a", () => gate.promise);
  await Promise.resolve();

  await assert.rejects(executor.run("a", async () => {}), (error) => error.code === "MESSAGE_QUEUE_FULL");
  gate.resolve();
  await first;

  let ran = false;
  await executor.run("b", async () => { ran = true; });
  assert.equal(ran, true);
});

test("a runnable new contact is admitted when the bounded queue is full of same-contact work", async () => {
  const executor = createMessageExecutor({ concurrency: 2, maxQueue: 1 });
  const gate = deferred();
  const first = executor.run("a", () => gate.promise);
  await Promise.resolve();
  const queuedSameContact = executor.run("a", async () => {});
  const unrelated = executor.run("b", async () => "ran");
  assert.equal(await unrelated, "ran");
  assert.equal(executor.getStats().queued, 1);
  gate.resolve();
  await Promise.all([first, queuedSameContact]);
});

test("a rejected task does not poison later tasks for that contact", async () => {
  const executor = createMessageExecutor({ concurrency: 1, maxQueue: 2 });
  await assert.rejects(executor.run("a", async () => { throw new Error("failed"); }), /failed/);
  let ran = false;
  await executor.run("a", async () => { ran = true; });
  assert.equal(ran, true);
});
