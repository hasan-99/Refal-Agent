$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed or is not available in PATH."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is not installed or is not available in PATH."
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing bot dependencies..."
  npm install
}

Write-Host ""
Write-Host "Starting WhatsApp Company Bot..."
Write-Host "On your phone, open WhatsApp > Settings > Linked devices > Link a device."
Write-Host "Scan the QR code that appears here. Keep this window open while the bot is online."
Write-Host "Press Ctrl+C to stop the bot."
Write-Host ""

npm start
