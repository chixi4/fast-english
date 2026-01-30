$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path (Join-Path $PSScriptRoot ".."))

if (-not $env:CLOUDFLARED_TUNNEL_NAME) { $env:CLOUDFLARED_TUNNEL_NAME = "vocabulary-study" }
if (-not $env:CLOUDFLARED_HOSTNAME) { $env:CLOUDFLARED_HOSTNAME = "yuookie.qzz.io" }
if (-not $env:CLOUDFLARED_SERVICE) { $env:CLOUDFLARED_SERVICE = "http://127.0.0.1:8000" }

& .\tools\cf_full_setup.ps1
& .\tools\share.ps1

