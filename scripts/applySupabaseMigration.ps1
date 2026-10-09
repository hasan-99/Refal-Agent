# Applies ONE named migration file to the configured Supabase project.
#
# Sibling of scripts/inspectSupabaseReadOnly.ps1 and deliberately shaped like it:
# same Windows Credential Manager loader, same Management API endpoint, same
# proxy handling. The only difference is `read_only = $false`.
#
#   pwsh -NoProfile -File .\scripts\applySupabaseMigration.ps1 `
#        -MigrationPath .\supabase\migrations\20261009180000_refal_fact_register.sql
#
#   # see the statement count and the project it would hit, change nothing:
#   pwsh -NoProfile -File .\scripts\applySupabaseMigration.ps1 -MigrationPath ... -Preview
#
# ONE FILE AT A TIME, BY NAME. There is no `push all pending` here on purpose.
# This repository's migration history is not guaranteed to match what the remote
# has actually had applied, so a bulk push could silently re-run forty files.
# Naming the file is the whole safety model.
#
# The credential is read from the Windows Credential Manager target
# "Supabase CLI:supabase", kept in process memory, and sent only as a bearer
# token to api.supabase.com. It is never printed, never written to disk, and
# never passed as a command argument.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string] $MigrationPath,
    [string] $ProjectRef = 'anhharmjtmqndhzenicb',
    [switch] $Preview
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SupabaseMigrationCredential {
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

$resolved = Resolve-Path -LiteralPath $MigrationPath
$sql = Get-Content -LiteralPath $resolved -Raw -Encoding utf8
if ([string]::IsNullOrWhiteSpace($sql)) { throw "Migration file is empty: $resolved" }

# The `-- ROLLBACK:` block at the end of every migration in this repo is a
# commented reverse script. It is documentation, not something to execute, and
# it is already inert because every line is a comment. Reported so the operator
# can see it was recognised rather than silently included.
$rollbackLines = ([regex]::Matches($sql, '(?m)^\s*--\s*ROLLBACK:')).Count

Write-Output "file        : $($resolved.Path)"
Write-Output "project     : $ProjectRef"
Write-Output "bytes       : $($sql.Length)"
Write-Output "rollback blk: $rollbackLines"

if ($Preview) {
    Write-Output 'PREVIEW - nothing was sent. Re-run without -Preview to apply.'
    exit 0
}

$request = @{
    Uri         = "https://api.supabase.com/v1/projects/$ProjectRef/database/query"
    Method      = 'Post'
    ContentType = 'application/json'
    Headers     = @{ Authorization = 'Bearer ' + [SupabaseMigrationCredential]::GetToken() }
    TimeoutSec  = 180
}
if ($env:HTTPS_PROXY) {
    $request.Proxy = $env:HTTPS_PROXY
    $request.ProxyUseDefaultCredentials = $true
}

# Prove the connection and the target BEFORE sending DDL, so a proxy failure or
# a wrong project ref surfaces as a failed SELECT rather than a half applied
# migration.
$check = Invoke-RestMethod @request -Body (@{ query = 'select current_database() as db, current_user as role;'; read_only = $true } | ConvertTo-Json)
Write-Output ('preflight   : ' + ($check | ConvertTo-Json -Compress))

if (-not $PSCmdlet.ShouldProcess($ProjectRef, "apply $(Split-Path -Leaf $resolved)")) {
    Write-Output 'Declined at the confirmation prompt. Nothing was sent.'
    exit 0
}

try {
    $result = Invoke-RestMethod @request -Body (@{ query = $sql; read_only = $false } | ConvertTo-Json)
    Write-Output ('APPLIED     : ' + ($result | ConvertTo-Json -Compress -Depth 5))
    exit 0
}
catch {
    # Surface the server's own message. It is the only thing that says WHICH
    # statement failed, and swallowing it turns a one line fix into a guess.
    $response = $_.ErrorDetails.Message
    if (-not $response -and $_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $response = $reader.ReadToEnd()
    }
    Write-Output 'FAILED      : the migration was NOT applied in full.'
    Write-Output ("server      : " + $response)
    exit 1
}
