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

**Read access, temporary-table SQL writes/schema edits/deletion, and Edge Function deployment/redeployment/invocation/deletion were verified on 2026-10-07.** Applying a recorded migration and changing existing application objects have not been tested. The existing inspection script deliberately remains read-only.

### Verified disposable capability test

The user-authorized live test in [scripts/testSupabaseCapabilities.ps1](scripts/testSupabaseCapabilities.ps1) passed:

- Created a temporary table, inserted a test row, added a column, updated the row, checked the edited values, deleted the row, verified no rows remained, and dropped the temporary table.
- Deployed a uniquely named Edge Function with `verify_jwt=true`, invoked it with an existing anon JWT, then edited/redeployed it and verified the response changed from revision 1 to revision 2.
- Deleted the disposable function and verified its absence from the remote function list. The test function had no database, environment, or external-service access in its source.
- Test resources were removed; existing application tables and functions were not modified. No migration history entries were created.

Evidence: [artifacts/supabase-capability-test.json](artifacts/supabase-capability-test.json), run at `2026-10-07T20:23:32Z`, disposable slug `codex-capability-test-f56f5df80f3f`.

Run the following only when a new live write/deploy/delete test is authorized; it creates new disposable resources each time:

```powershell
pwsh -NoProfile -File .\scripts\testSupabaseCapabilities.ps1
```

The working deployment uses PowerShell `-Form` with a `file` part and JSON `metadata` containing `entrypoint_path`, `name`, and `verify_jwt`, sent to `POST /v1/projects/{ref}/functions/deploy?slug={slug}`. Cleanup uses `DELETE /v1/projects/{ref}/functions/{slug}`. Both use the same authenticated proxy transport as the SQL requests. See the [official deployment documentation](https://supabase.com/docs/reference/api/v1-deploy-a-function).

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

## Operation recipes for the next session

These recipes document the transport exercised by the successful live test. Replace task-specific placeholders only after identifying the intended resource. Do not run the full capability test just to initialize a connection: it deploys and deletes a disposable function.

### 1. Initialize the authenticated connection

Start a fresh PowerShell 7 session in `C:\SharedProjects\refal-Agent`. Dot-source the read-only script to load the credential helper and request configuration; this also runs the connection/schema inspection:

```powershell
$ErrorActionPreference = 'Stop'
. .\scripts\inspectSupabaseReadOnly.ps1 | Out-Null
$baseUri = "https://api.supabase.com/v1/projects/$projectRef"
$transport = @{ TimeoutSec = 60 }
if ($env:HTTPS_PROXY) {
    $transport.Proxy = $env:HTTPS_PROXY
    $transport.ProxyUseDefaultCredentials = $true
}
$management = $transport.Clone()
$management.Headers = $request.Headers
```

Keep `$request` and `$management` private: they contain the authorization header. Send `$management` only to the Supabase Management API. The following recipes use these variables in the same session.

### 2. Read database metadata or authorized data

Use `read_only = $true` for inspection. Select only the columns/rows needed for the task; avoid dumping customer data.

```powershell
$sql = 'SELECT 1 AS connection_ok;'
$body = @{ query = $sql; read_only = $true } | ConvertTo-Json
Invoke-RestMethod @management -Uri "$baseUri/database/query" `
    -Method Post -ContentType 'application/json' -Body $body
```

For the complete table/column/constraint/RLS inventory, run the read-only script directly. Its SQL catalog query is also available in the script for reuse.

### 3. Edit database data or remove rows

First read the exact target rows and inspect dependencies. Prepare a task-specific SQL file with bounded `UPDATE`/`DELETE` predicates and assertions for the expected affected rows. Use a transaction where appropriate. The transport is:

```powershell
# Replace with the reviewed SQL file for the user's authorized operation.
$sql = Get-Content -LiteralPath '.\artifacts\REPLACE_WITH_REVIEWED_CHANGE.sql' -Raw
$body = @{ query = $sql; read_only = $false } | ConvertTo-Json
Invoke-RestMethod @management -Uri "$baseUri/database/query" `
    -Method Post -ContentType 'application/json' -Body $body
```

Then run a separate read-only query to verify the changed values or absence of the deleted rows. Do not automatically retry a write after a timeout: first inspect whether it succeeded. Table/column removal requires an explicit target and dependency review; never add `CASCADE` merely to get past an error.

This route passed create/insert/alter/update/delete/drop tests on a temporary table. For permanent schema changes, use the repository's migration workflow and verify remote migration history. **A successful raw SQL request does not record or verify a migration.**

### 4. Read deployed function metadata

```powershell
$functions = Invoke-RestMethod @management -Uri "$baseUri/functions" -Method Get
$functions | Select-Object slug, status, version, verify_jwt
```

Identify the exact slug before editing or deleting. Compare deployed metadata with local `supabase/functions/<slug>/` source and `supabase/config.toml`; do not assume local source is identical to the deployed version.

### 5. Deploy a function or edit and redeploy it

Edit and validate the intended local source first. For a single-file function without local imports, the verified multipart upload shape is:

```powershell
$slug = 'REPLACE_WITH_TARGET_FUNCTION_SLUG'
$sourcePath = '.\supabase\functions\REPLACE_WITH_TARGET_FUNCTION_SLUG\index.ts'
$metadata = @{
    name = $slug
    entrypoint_path = 'index.ts'
    verify_jwt = $true
}
$form = @{
    metadata = ($metadata | ConvertTo-Json -Compress)
    file = Get-Item -LiteralPath $sourcePath
}
$deployed = Invoke-RestMethod @management `
    -Uri "$baseUri/functions/deploy?slug=$slug" -Method Post -Form $form
$deployed | Select-Object slug, status, version, verify_jwt
```

Use the intended function name and JWT setting from its reviewed configuration; `$true` above matches the disposable test. Preserve existing authentication behavior unless changing it is part of the task. The same slug updates the existing function: the test verified version 1 and then version 2.

PowerShell creates the multipart boundary: do not manually set a multipart `Content-Type`. For functions with local imports, shared modules, import maps, or static assets, prepare the complete dependency bundle using the current supported API/CLI workflow. The single-file example alone is insufficient for those functions.

Verify `ACTIVE`, the returned slug/version/auth configuration, and the function's actual response. Invoke `https://<project-ref>.supabase.co/functions/v1/<slug>` using that function's intended caller authentication, **not** the Management API token. The disposable test used an existing anon JWT kept in memory; a real application endpoint may require a signed-in user or additional authorization. Do not disable JWT verification to make a test pass. Use bounded retries for deployment propagation and check the expected response revision.

### 6. Remove an Edge Function

Check callers, jobs, and dependencies for the exact function the user asked to remove. For a disposable test, delete only the unique slug created by that test.

```powershell
$slug = 'REPLACE_WITH_AUTHORIZED_FUNCTION_TO_DELETE'
Invoke-RestMethod @management -Uri "$baseUri/functions/$slug" -Method Delete | Out-Null
$remaining = Invoke-RestMethod @management -Uri "$baseUri/functions" -Method Get
if ($remaining | Where-Object slug -eq $slug) {
    throw "Function still appears in the remote list: $slug"
}
```

The live test verified deletion and absence from the remote list. For existing application functions, also update authorized callers/configuration as required by the task; deleting a deployed function does not delete its local source directory.

### Completion checklist

- State the project and exact objects changed.
- Verify the requested behavior after edits, and verify absence after removal.
- Keep credentials out of output and saved artifacts.
- Save reusable findings in this guide and `.skyops/knowledge/`.
- Distinguish local file edits, Git publication, and Supabase deployment: completing one does not complete the others.

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
