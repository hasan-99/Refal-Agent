# Supabase access guide for this Windows PC

Last verified: 2026-10-07. Repository: `C:\SharedProjects\refal-Agent`.

## What to tell the assistant next time

> Read SUPABASE-ACCESS-GUIDE.md and use the saved Windows proxy authentication flow. Apply [migration filename / requested change / Edge Function deployment] to the configured Supabase project, then verify the result.

From another workspace, provide the full path:

> Read C:\SharedProjects\refal-Agent\SUPABASE-ACCESS-GUIDE.md before working on Supabase.

## Verified connection method

- Project reference used: `anhharmjtmqndhzenicb`. Check the current task's target against the repository configuration before any write; the inspection script currently hardcodes this reference.
- The corporate proxy requires Windows authentication. A McAfee gateway page did not establish that Supabase was prohibited: PowerShell revealed HTTP 407, and supplying the current Windows user's proxy credentials resolved it.
- PowerShell `Invoke-RestMethod` works with `-Proxy $env:HTTPS_PROXY -ProxyUseDefaultCredentials` on this PC.
- Supabase authentication uses the existing CLI login credential in Windows Credential Manager, target `Supabase CLI:supabase`.
- The script reads only that credential using Windows `CredReadW`, keeps it in process memory, and sends it as a bearer token only to the Supabase Management API. Never print it, put it in command arguments, or save it in a file.
- Keep the existing proxy and TLS certificate verification enabled. No firewall changes or proxy bypass were needed.

The executable reference is [scripts/inspectSupabaseReadOnly.ps1](scripts/inspectSupabaseReadOnly.ps1). Reuse its credential-loading and authenticated-request pattern rather than rediscovering the connection.

## Quick connection and schema check

Run in a fresh PowerShell 7 process from this repository:

```powershell
pwsh -NoProfile -File .\scripts\inspectSupabaseReadOnly.ps1
```

The script calls `POST https://api.supabase.com/v1/projects/{projectRef}/database/query` with `read_only: true`. It first runs:

```sql
SELECT 1 AS connection_ok;
```

Expected result: `connection_ok = 1`. It then reads PostgreSQL catalog metadata: table names, column types and nullability, constraints, and whether row-level security is enabled. It does not read customer records or modify the database.

Each run refreshes [artifacts/supabase-schema-inspection.json](artifacts/supabase-schema-inspection.json). The [Markdown schema report](artifacts/supabase-schema-inspection.md) is a separately generated snapshot and is **not** automatically refreshed by the script.

The successful 2026-10-07 inspection found 67 tables across seven schemas, including 26 public tables with RLS enabled. These are historical observations, not guaranteed current counts. RLS enabled alone does not establish that policies are correct.

## Editing, migrations, removal, and deployment

**Only read-only database access has been verified through this route. Database writes, migration application, and Edge Function deployment have not yet been tested.** The existing inspection script deliberately remains read-only.

For a future authorized change:

1. Read the repository's `AGENTS.md`, relevant Supabase skills, and this guide. Check current CLI help or official Management API documentation for the operation being performed.
2. Confirm the target project from task context and configuration; run the read-only connection check. Reuse the proxy authentication pattern if CLI requests return gateway HTML.
3. Inspect the live objects and dependencies affected by the requested change. Preserve repository privacy, approved-knowledge, appointment, and prompt-alignment requirements.
4. Prepare the requested source changes or migration in the repository's established workflow. Before removal, identify exactly what will be deleted and its dependencies. Obtain clarification only if the requested scope is ambiguous or authorization is missing.
5. For migrations, inspect existing remote migration history and use an operation that preserves that history. Executing raw SQL successfully is not by itself proof that a migration was recorded. Verify the current supported migration API/CLI before choosing a transport.
6. For Edge Functions, verify the current deployment API/CLI, required permissions, entrypoint/import map, and JWT configuration. A database query endpoint cannot deploy function source.
7. Execute only the authorized operation using a task-specific command or helper. Do not turn the inspection script into an unrestricted write tool. If write/deploy permission is denied, report the specific missing access instead of assuming read access implies write access.
8. Verify the result: schema and migration history for migrations; deployed version/status and an appropriate smoke check for functions; relevant repository tests for changed behavior. Report what changed and what was verified.

Reference: [Supabase Management API](https://supabase.com/docs/reference/api/introduction). Check current documentation when implementing; this guide records a working transport, not a permanent API contract.

## Troubleshooting

| Symptom | Next action |
| --- | --- |
| McAfee HTML or HTTP 407 | Use the configured proxy with `ProxyUseDefaultCredentials`; this resolved the observed failure. |
| Supabase HTTP 401 | Check the saved CLI login; run `supabase login` interactively if necessary. Do not paste tokens into chat. |
| Supabase HTTP 403 | Check the account/token's access to this project and the requested operation. |
| CLI reports IPv6 unsupported | Do not conclude the project is unreachable. The authenticated HTTPS Management API route worked on this PC. |
| Windows credential missing | Run `supabase login` under the intended Windows user, then retry. |
| Proxy variable missing or network changed | Inspect the current supported network configuration; do not hardcode or disable security settings. |

## Where this is remembered

- `AGENTS.md` points future agents to this guide before Supabase work.
- `.skyops/knowledge/INDEX.md` indexes the lesson and this guide.
- `.skyops/knowledge/fixes.md` records the verified diagnosis and fix.

This is durable project memory on disk. A session in another repository may need the full guide path explicitly. No credentials are stored in this guide or the knowledge files.
