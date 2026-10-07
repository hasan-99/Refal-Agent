<a id="20261007-supabase-proxy-auth"></a>
- **[2026-10-07] Supabase corporate proxy authentication** <!-- id: 20261007-supabase-proxy-auth -->
  - What: Supabase CLI returned McAfee gateway HTML; PowerShell exposed HTTP 407 proxy authentication required. Invoke-RestMethod with the configured HTTPS_PROXY and ProxyUseDefaultCredentials reached Supabase through the existing corporate proxy. Reusing only the saved Supabase CLI credential then succeeded through the Management API with read_only=true.
  - Evidence/where: scripts/inspectSupabaseReadOnly.ps1; artifacts/supabase-schema-inspection.json records connection_ok=1 and 67 table definitions on 2026-10-07.
  - Apply when: Supabase commands return gateway HTML on this Windows network. Authenticate to the existing proxy; do not disable proxy or TLS verification. Never print or persist the CLI credential. This script is Windows-specific and inspects metadata only.
  - Reuse guide: `SUPABASE-ACCESS-GUIDE.md` contains the exact invocation, troubleshooting, and next steps for future migrations or deployments. `AGENTS.md` points future sessions to it. The subsequent disposable capability test below verifies writes and deployments; migration history application remains untested.

<a id="20261007-supabase-capabilities"></a>
- **[2026-10-07] Supabase write and deployment capabilities verified** <!-- id: 20261007-supabase-capabilities -->
  - What: The authenticated PowerShell transport supports SQL with read_only=false, multipart Edge Function deployment and redeployment, invocation with JWT verification enabled, and deletion. Temporary-table create/insert/alter/update/delete/drop all passed. Both function revisions returned the expected response; remote cleanup was verified.
  - Evidence/where: `scripts/testSupabaseCapabilities.ps1`, `artifacts/supabase-capability-test.json`, and `SUPABASE-ACCESS-GUIDE.md`. Existing application objects and migration history were not changed.
  - Apply when: Authorized Supabase edits/deployments on this PC. Reuse the transport and multipart request shape, preserve target JWT settings, and verify the exact changed resource. Recorded migrations still require their own workflow verification.
