export function createAgentApiHeaders({ apiKey, apiSecret }) {
  const key = String(apiKey || "").trim();
  const secret = String(apiSecret || "").trim();
  if (!key || !secret) throw new Error("RAFA Supabase agent API authentication is not configured.");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "x-rafa-api-secret": secret
  };
}
