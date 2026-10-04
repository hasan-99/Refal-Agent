import test from "node:test";
import assert from "node:assert/strict";
import { fetchConversationLists, watchForConversationListChanges } from "./src/conversationListRefresh.js";

test("inbox list refresh replaces a push-name/number label with the newly saved contact name", async () => {
  const selectedId = "210277387751547@lid";
  let savedName = "WhatsApp number";
  let rows = [{ userId: selectedId, user: { id: selectedId, name: savedName } }];
  let leads = [{ id: selectedId, name: savedName }];
  const fetcher = async (url, options) => {
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "include");
    assert.equal(options.method, undefined, "refresh must not mutate or delete data");
    const payload = url === "/api/conversations"
      ? { conversations: [{ userId: selectedId, user: { id: selectedId, name: savedName } }] }
      : { users: [{ id: selectedId, name: savedName }] };
    return { ok: true, json: async () => payload };
  };

  const first = await fetchConversationLists(fetcher);
  rows = first.rows;
  leads = first.leads;
  assert.equal(rows[0].user.name, "WhatsApp number");

  savedName = "Hasan";
  const refreshed = await fetchConversationLists(fetcher);
  rows = refreshed.rows;
  leads = refreshed.leads;
  assert.equal(rows[0].user.name, "Hasan");
  assert.equal(leads[0].name, "Hasan");
  assert.equal(selectedId, "210277387751547@lid", "list refresh must not navigate away from the selected transcript");
});

test("inbox watches refresh on focus and periodically only while the tab is visible", () => {
  const listeners = new Map();
  const windowTarget = {
    addEventListener: (name, handler) => listeners.set(`window:${name}`, handler),
    removeEventListener: (name) => listeners.delete(`window:${name}`)
  };
  const documentTarget = {
    visibilityState: "visible",
    addEventListener: (name, handler) => listeners.set(`document:${name}`, handler),
    removeEventListener: (name) => listeners.delete(`document:${name}`)
  };
  let tick;
  let cleared = null;
  let refreshes = 0;
  const stop = watchForConversationListChanges({
    refresh: () => { refreshes += 1; },
    windowTarget,
    documentTarget,
    intervalMs: 15000,
    setIntervalFn: (callback, delay) => { assert.equal(delay, 15000); tick = callback; return 7; },
    clearIntervalFn: (id) => { cleared = id; }
  });

  listeners.get("window:focus")();
  assert.equal(refreshes, 1);
  documentTarget.visibilityState = "hidden";
  tick();
  listeners.get("document:visibilitychange")();
  assert.equal(refreshes, 1);
  documentTarget.visibilityState = "visible";
  tick();
  assert.equal(refreshes, 2);

  stop();
  assert.equal(cleared, 7);
  assert.equal(listeners.size, 0);
});
