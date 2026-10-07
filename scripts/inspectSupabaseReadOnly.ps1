$ErrorActionPreference = 'Stop'

# Reuse only the Supabase CLI credential; never print or persist its value.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SupabaseInspectionCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr credential);
    public static string GetToken() {
        IntPtr ptr;
        if (!Read("Supabase CLI:supabase", 1, 0, out ptr))
            throw new InvalidOperationException("Supabase CLI credential is unavailable. Run supabase login.");
        try {
            var item = Marshal.PtrToStructure<Credential>(ptr);
            var bytes = new byte[item.CredentialBlobSize];
            Marshal.Copy(item.CredentialBlob, bytes, 0, bytes.Length);
            return (bytes.Length > 1 && bytes[1] == 0
                ? System.Text.Encoding.Unicode.GetString(bytes)
                : System.Text.Encoding.UTF8.GetString(bytes)).TrimEnd('\0');
        } finally { CredFree(ptr); }
    }
}
'@

$projectRef = 'anhharmjtmqndhzenicb'
$request = @{
    Uri = "https://api.supabase.com/v1/projects/$projectRef/database/query"
    Method = 'Post'
    ContentType = 'application/json'
    Headers = @{ Authorization = 'Bearer ' + [SupabaseInspectionCredential]::GetToken() }
    TimeoutSec = 45
}
if ($env:HTTPS_PROXY) {
    $request.Proxy = $env:HTTPS_PROXY
    $request.ProxyUseDefaultCredentials = $true
}

$check = Invoke-RestMethod @request -Body (@{ query = 'SELECT 1 AS connection_ok;'; read_only = $true } | ConvertTo-Json)
Write-Output ('Connection check: ' + ($check | ConvertTo-Json -Compress))

$query = @'
SELECT n.nspname AS schema_name, c.relname AS table_name, c.relrowsecurity AS rls_enabled,
  (SELECT jsonb_agg(jsonb_build_object(
    'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
    'nullable', NOT a.attnotnull) ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT jsonb_agg(jsonb_build_object('name', k.conname,
    'definition', pg_catalog.pg_get_constraintdef(k.oid)) ORDER BY k.conname)
   FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid) AS constraints
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY n.nspname, c.relname;
'@
$tables = Invoke-RestMethod @request -Body (@{ query = $query; read_only = $true } | ConvertTo-Json)
$artifactDir = Join-Path $PSScriptRoot '..\artifacts'
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
$result = @{ project_ref = $projectRef; inspected_at = [DateTimeOffset]::UtcNow.ToString('o'); connection_check = $check; tables = $tables }
$result | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $artifactDir 'supabase-schema-inspection.json') -Encoding utf8
$tables | Group-Object schema_name | Select-Object Name, Count | Format-Table
$tables | Where-Object schema_name -eq 'public' | Select-Object table_name, rls_enabled, @{n='column_count';e={$_.columns.Count}} | Format-Table
