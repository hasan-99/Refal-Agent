$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$paths = @("auth_info_baileys", ".wwebjs_auth", ".wwebjs_cache")

foreach ($relativePath in $paths) {
  $target = Resolve-Path -LiteralPath $relativePath -ErrorAction SilentlyContinue
  if ($target -and $target.Path.StartsWith($PSScriptRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $target.Path -Recurse -Force
    Write-Host "Removed $relativePath"
  }
}

Write-Host "WhatsApp session cleared. Run npm run start:windows and scan the QR again."
