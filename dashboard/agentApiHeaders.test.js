import test from "node:test";
import assert from "node:assert/strict";
import { createAgentApiHeaders } from "./agentApiHeaders.js";

test("agent Edge requests carry the Supabase gateway key and private REFAL secret", () => {
  assert.deepEqual(createAgentApiHeaders({ apiKey: "sb_publishable-test", apiSecret: "rafa-secret" }), {
    apikey: "sb_publishable-test",
    authorization: "Bearer sb_publishable-test",
    "x-rafa-api-secret": "rafa-secret"
  });
});

test("agent Edge request authentication fails closed when either credential is missing", () => {
  assert.throws(() => createAgentApiHeaders({ apiKey: "", apiSecret: "rafa-secret" }), /authentication is not configured/);
  assert.throws(() => createAgentApiHeaders({ apiKey: "sb_publishable-test", apiSecret: "" }), /authentication is not configured/);
});
