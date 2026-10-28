// Provider credentials may be held in Supabase Vault so they can be rotated
// without placing them in ordinary application settings. Keep the value in the
// Edge isolate only; never return it from an API route or include it in logs.
/**
 * @param {{ readVaultSecret: () => Promise<string> | string, readEnvironmentSecret?: () => string, cacheMs?: number, now?: () => number }} options
 */
export function createProviderSecretLoader({
  readVaultSecret,
  readEnvironmentSecret = () => "",
  cacheMs = 5 * 60 * 1000,
  now = Date.now
} = {}) {
  if (typeof readVaultSecret !== "function" || typeof readEnvironmentSecret !== "function") {
    throw new TypeError("Provider secret readers are required.");
  }
  let cachedValue = "";
  let expiresAt = 0;

  return async function loadProviderSecret() {
    if (cachedValue && now() < expiresAt) return cachedValue;
    let vaultValue = "";
    try { vaultValue = String(await readVaultSecret() || "").trim(); }
    catch { /* A configured Edge secret remains a safe fallback. */ }
    const value = vaultValue || String(readEnvironmentSecret() || "").trim();
    if (!value) throw new Error("Provider credential is unavailable.");
    cachedValue = value;
    expiresAt = now() + Math.max(1000, Number(cacheMs) || 0);
    return cachedValue;
  };
}
