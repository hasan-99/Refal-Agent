# Explicit live capability test: temporary SQL objects and a disposable Edge Function.
# Run only when authorized to test database writes and function deployment/deletion.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'inspectSupabaseReadOnly.ps1') | Out-Null
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$slug = 'codex-capability-test-' + $suffix
$table = 'codex_capability_test_' + $suffix
$baseUri = "https://api.supabase.com/v1/projects/$projectRef"
$transport = @{ TimeoutSec = 60 }
if ($env:HTTPS_PROXY) { $transport.Proxy = $env:HTTPS_PROXY; $transport.ProxyUseDefaultCredentials = $true }
$management = $transport.Clone()
$management.Headers = $request.Headers
$results = [ordered]@{ project_ref = $projectRef; tested_at = [DateTimeOffset]::UtcNow.ToString('o'); function_slug = $slug }
$reportPath = Join-Path $PSScriptRoot '..\artifacts\supabase-capability-test.json'
$functionAttempted = $false
$sourceDir = Join-Path $PSScriptRoot ('..\artifacts\' + $slug)

try {
    # Every modified SQL object is session-local; all row mutations have a specific ID.
    $sql = @'
BEGIN;
SET LOCAL statement_timeout = '10s';
CREATE TEMP TABLE __TABLE__ (id bigint PRIMARY KEY, value text NOT NULL) ON COMMIT DROP;
INSERT INTO pg_temp.__TABLE__ (id, value) VALUES (1, 'before');
ALTER TABLE pg_temp.__TABLE__ ADD COLUMN verified boolean NOT NULL DEFAULT false;
UPDATE pg_temp.__TABLE__ SET value = 'after', verified = true WHERE id = 1;
DO $check$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.__TABLE__ WHERE id = 1 AND value = 'after' AND verified)
  THEN RAISE EXCEPTION 'Edit verification failed'; END IF;
END $check$;
DELETE FROM pg_temp.__TABLE__ WHERE id = 1;
DO $check$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.__TABLE__)
  THEN RAISE EXCEPTION 'Delete verification failed'; END IF;
END $check$;
DROP TABLE pg_temp.__TABLE__;
COMMIT;
SELECT true AS create_insert_alter_update_delete_passed,
       to_regclass('pg_temp.__TABLE__') IS NULL AS temporary_table_removed;
'@
    $sql = $sql.Replace('__TABLE__', $table)
    $db = Invoke-RestMethod @management -Uri "$baseUri/database/query" -Method Post -ContentType 'application/json' -Body (@{query=$sql;read_only=$false} | ConvertTo-Json)
    if (!$db[0].create_insert_alter_update_delete_passed -or !$db[0].temporary_table_removed) { throw 'Database verification failed.' }
    $results.database = $db
    Write-Output 'PASS: temporary table create, insert, schema edit, row edit, row delete, and table removal.'

    $before = Invoke-RestMethod @management -Uri "$baseUri/functions" -Method Get
    if ($before | Where-Object slug -eq $slug) { throw 'Unexpected function name collision.' }
    # Read the existing anon JWT only for this no-data test function; do not print keys.
    $keys = Invoke-RestMethod @management -Uri "$baseUri/api-keys" -Method Get
    $anon = ($keys | Where-Object name -eq 'anon' | Select-Object -First 1).api_key
    $keys = $null
    if (!$anon -or !$anon.StartsWith('eyJ')) { throw 'No existing anon JWT available; refusing to disable function JWT verification.' }
    $invoke = $transport.Clone()
    $invoke.Headers = @{ Authorization = 'Bearer ' + $anon; apikey = $anon }
    New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null
    $sourcePath = Join-Path $sourceDir 'index.ts'
    foreach ($revision in @(1, 2)) {
        # No secrets, database access, environment access, or external calls in this function.
        $source = 'Deno.serve(() => Response.json({ok:true,test:"' + $slug + '",revision:' + $revision + '}));'
        Set-Content -LiteralPath $sourcePath -Value $source -Encoding utf8
        $form = @{ metadata = (@{name=$slug;entrypoint_path='index.ts';verify_jwt=$true} | ConvertTo-Json -Compress); file = Get-Item -LiteralPath $sourcePath }
        $functionAttempted = $true
        $deployed = Invoke-RestMethod @management -Uri "$baseUri/functions/deploy?slug=$slug" -Method Post -Form $form
        if ($deployed.slug -ne $slug -or $deployed.status -ne 'ACTIVE' -or !$deployed.verify_jwt) { throw 'Unexpected deployment metadata.' }
        $response = $null
        for ($attempt = 0; $attempt -lt 6; $attempt++) {
            try { $response = Invoke-RestMethod @invoke -Uri "https://$projectRef.supabase.co/functions/v1/$slug" -Method Get } catch {
                if ($attempt -eq 5) { throw }; Start-Sleep -Seconds 2; continue
            }
            if ($response.ok -and $response.test -eq $slug -and $response.revision -eq $revision) { break }
            Start-Sleep -Seconds 2
        }
        if (!$response.ok -or $response.test -ne $slug -or $response.revision -ne $revision) { throw 'Function invocation did not return the expected revision.' }
        $results["function_revision_$revision"] = @{status=$deployed.status;version=$deployed.version;verify_jwt=$deployed.verify_jwt;response=$response}
        Write-Output "PASS: function revision $revision deployed and invoked successfully."
    }
} finally {
    try {
        if ($functionAttempted) {
            $existing = Invoke-RestMethod @management -Uri "$baseUri/functions" -Method Get
            if ($existing | Where-Object slug -eq $slug) {
                Invoke-RestMethod @management -Uri "$baseUri/functions/$slug" -Method Delete | Out-Null
            }
            $remaining = Invoke-RestMethod @management -Uri "$baseUri/functions" -Method Get
            $results.function_removed = ![bool]($remaining | Where-Object slug -eq $slug)
            if (!$results.function_removed) { throw "Cleanup failed for $slug" }
            Write-Output 'PASS: disposable function deleted and absence verified.'
        }
    } finally {
        $results | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding utf8
    }
}
