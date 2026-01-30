$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path (Join-Path $PSScriptRoot ".."))

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "cloudflared not found. Install it first:"
  Write-Host "  winget install --id Cloudflare.cloudflared"
  exit 1
}

$tunnelName = if ($env:CLOUDFLARED_TUNNEL_NAME) { $env:CLOUDFLARED_TUNNEL_NAME } else { "vocabulary-study" }

Start-Process powershell.exe -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", ".\\run.ps1"
) -WorkingDirectory (Get-Location).Path

Write-Host ("Starting Cloudflare Tunnel: " + $tunnelName)
$cfg = Join-Path $HOME ".cloudflared\\$tunnelName.yml"
if (Test-Path $cfg) {
  cloudflared tunnel --config $cfg run
} else {
  cloudflared tunnel run $tunnelName
}
