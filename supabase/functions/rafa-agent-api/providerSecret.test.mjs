import test from "node:test";
import assert from "node:assert/strict";
import { createProviderSecretLoader } from "./providerSecret.mjs";

test("provider credentials prefer encrypted Vault storage over a stale Edge environment value", async () => {
  const load = createProviderSecretLoader({
    readVaultSecret: async () => "vault-current-key",
    readEnvironmentSecret: () => "environment-old-key"
  });
  assert.equal(await load(), "vault-current-key");
});

test("provider credential loader caches for its short rotation window", async () => {
  let now = 10;
  let reads = 0;
  let value = "first-key";
  const load = createProviderSecretLoader({
    readVaultSecret: async () => { reads += 1; return value; },
    cacheMs: 1000,
    now: () => now
  });
  assert.equal(await load(), "first-key");
  value = "rotated-key";
  assert.equal(await load(), "first-key");
  assert.equal(reads, 1);
  now += 1001;
  assert.equal(await load(), "rotated-key");
  assert.equal(reads, 2);
});

test("environment credential is a fallback and missing credentials fail without leaking values", async () => {
  const fallback = createProviderSecretLoader({
    readVaultSecret: async () => { throw new Error("database secret lookup failed"); },
    readEnvironmentSecret: () => "environment-key"
  });
  assert.equal(await fallback(), "environment-key");

  const missing = createProviderSecretLoader({ readVaultSecret: async () => "" });
  await assert.rejects(missing(), /Provider credential is unavailable/u);
});
