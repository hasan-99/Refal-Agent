# =============================================================================
# W0.1.3 database baseline runner — READ ONLY
# =============================================================================
# Runs supabase/inspection/W0.1.3_database_baseline_SINGLE.sql against the
# configured Supabase project with read_only = $true and writes the result as
# JSON to the path given by -OutFile (default: a file under $env:TEMP).
#
# Why this exists rather than dot-sourcing inspectSupabaseReadOnly.ps1:
#   that script also runs its own catalog inspection and refreshes
#   artifacts/supabase-schema-inspection.json, which dirties the working tree.
#   This runner reuses only its credential-loading and proxy pattern, as
#   SUPABASE-ACCESS-GUIDE.md instructs, and touches no repository artifact.
#
# SAFETY
#   read_only = $true on every request. The SQL file contains only SELECTs.
#   The bearer token is read from Windows Credential Manager into process
#   memory and is never printed, logged, or written to the output file.
# =============================================================================

[CmdletBinding()]
param(
    [string] $SqlPath  = (Join-Path $PSScriptRoot '..\supabase\inspection\W0.1.3_database_baseline_SINGLE.sql'),
    [string] $OutFile  = (Join-Path $env:TEMP 'w013_baseline.json'),
    [string] $ProjectRef = 'anhharmjtmqndhzenicb'
)

$ErrorActionPreference = 'Stop'

# Reuse only the Supabase CLI credential; never print or persist its value.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SupabaseBaselineCredential {
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

$request = @{
    Uri         = "https://api.supabase.com/v1/projects/$ProjectRef/database/query"
    Method      = 'Post'
    ContentType = 'application/json'
    Headers     = @{ Authorization = 'Bearer ' + [SupabaseBaselineCredential]::GetToken() }
    TimeoutSec  = 90
}
if ($env:HTTPS_PROXY) {
    $request.Proxy = $env:HTTPS_PROXY
    $request.ProxyUseDefaultCredentials = $true
}

# Connection check first, so a transport failure is distinguishable from a SQL failure.
$check = Invoke-RestMethod @request -Body (@{ query = 'SELECT 1 AS connection_ok;'; read_only = $true } | ConvertTo-Json)
Write-Output ('Connection check: ' + ($check | ConvertTo-Json -Compress))

$sql = Get-Content -LiteralPath $SqlPath -Raw
if ($sql -match '(?im)^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b') {
    throw "Refusing to run: $SqlPath contains a non-SELECT statement."
}

$result = Invoke-RestMethod @request -Body (@{ query = $sql; read_only = $true } | ConvertTo-Json)
$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutFile -Encoding utf8

Write-Output ("Rows returned: " + @($result).Count)
Write-Output ("Written to: " + $OutFile)
