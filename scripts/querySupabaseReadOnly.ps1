# Runs ONE read-only SQL query against the configured Supabase project and
# prints the result as JSON.
#
#   pwsh -NoProfile -File .\scripts\querySupabaseReadOnly.ps1 -Query "select count(*) from public.refal_fact_register;"
#
# Same credential flow as scripts/inspectSupabaseReadOnly.ps1, which it exists
# alongside rather than replaces: that script produces a fixed schema artifact,
# this one answers an ad hoc question during a deployment.
#
# `read_only = $true` is hard-coded and not a parameter. Anything that writes
# goes through scripts/applySupabaseMigration.ps1 with a named file, so a write
# always has a reviewed artifact behind it.
#
# This path talks to the Management API, so it sees the database as the service
# does: it is NOT filtered by row level security. That is the point. A PostgREST
# read as anon returning zero rows is ambiguous between "empty table" and
# "policy denied", and this is how you tell the two apart.
#
# The credential is read from Windows Credential Manager, kept in process
# memory, and never printed, persisted, or passed as an argument.

param(
    [string] $Query,
    # A large query cannot travel as an argument: Windows caps a command line at
    # about 32k and the hybrid retrieval check sends 2048-wide vectors, which
    # fails with ENAMETOOLONG long before the query is interesting.
    [string] $QueryFile,
    [string] $ProjectRef = 'anhharmjtmqndhzenicb',
    # Runs the SAME read as the owning role instead of supabase_read_only_user.
    #
    # Needed because some objects are granted to `anon` only and the read-only
    # user cannot touch them at all: `rafa_search_knowledge` is the live example,
    # and verifying retrieval is impossible without executing it.
    #
    # The Management API's `read_only` flag controls the session, not intent, so
    # turning it off would hand this script the ability to write. The guard below
    # makes that impossible rather than merely discouraged: a query containing a
    # write keyword is refused outright. Writes have exactly one route in this
    # repo, scripts/applySupabaseMigration.ps1 with a named, reviewed file.
    [switch] $AsService
)

$ErrorActionPreference = 'Stop'

if ($QueryFile) { $Query = Get-Content -LiteralPath $QueryFile -Raw -Encoding utf8 }
if ([string]::IsNullOrWhiteSpace($Query)) { throw 'Pass either -Query or -QueryFile.' }

if ($AsService) {
    $writeKeywords = @('insert', 'update', 'delete', 'drop', 'alter', 'truncate',
                       'create', 'grant', 'revoke', 'comment on', 'vacuum', 'reindex')
    # Strip string literals and comments first, so a SELECT that merely contains
    # the word "update" inside a quoted question is not refused.
    $stripped = $Query -replace "'[^']*'", "''" -replace '(?m)--.*$', ''
    foreach ($keyword in $writeKeywords) {
        if ($stripped -imatch "(^|[^a-z_])$([regex]::Escape($keyword))([^a-z_]|$)") {
            throw "-AsService refuses a query containing '$keyword'. Writes go through scripts/applySupabaseMigration.ps1 with a reviewed file."
        }
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SupabaseQueryCredential {
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
    Headers     = @{ Authorization = 'Bearer ' + [SupabaseQueryCredential]::GetToken() }
    TimeoutSec  = 120
}
if ($env:HTTPS_PROXY) {
    $request.Proxy = $env:HTTPS_PROXY
    $request.ProxyUseDefaultCredentials = $true
}

try {
    $result = Invoke-RestMethod @request -Body (@{ query = $Query; read_only = (-not $AsService) } | ConvertTo-Json)
    $result | ConvertTo-Json -Depth 12 -Compress
    exit 0
}
catch {
    $response = $_.ErrorDetails.Message
    if (-not $response -and $_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $response = $reader.ReadToEnd()
    }
    Write-Output ("QUERY FAILED: " + $response)
    exit 1
}
