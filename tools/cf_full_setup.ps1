$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path (Join-Path $PSScriptRoot ".."))

$tunnelName = if ($env:CLOUDFLARED_TUNNEL_NAME) { $env:CLOUDFLARED_TUNNEL_NAME } else { "vocabulary-study" }
$hostname = if ($env:CLOUDFLARED_HOSTNAME) { $env:CLOUDFLARED_HOSTNAME } else { "yuookie.qzz.io" }
$service = if ($env:CLOUDFLARED_SERVICE) { $env:CLOUDFLARED_SERVICE } else { "http://127.0.0.1:8000" }

function Ensure-Cloudflared {
  if (Get-Command cloudflared -ErrorAction SilentlyContinue) { return }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "cloudflared not found, and winget is missing. Install cloudflared and ensure it is on PATH."
  }

  Write-Host "cloudflared not found. Installing via winget..."
  winget install --id Cloudflare.cloudflared --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Host

  $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    throw "cloudflared install finished but command still not found. Open a new terminal and rerun tools\\cf_full_setup.ps1"
  }
}

function Ensure-Login {
  $cloudflaredDir = Join-Path $HOME ".cloudflared"
  $certPath = Join-Path $cloudflaredDir "cert.pem"

  if (Test-Path $certPath) { return }

  Write-Host "Cloudflare login required. A browser window will open."
  Write-Host "Please select the zone that contains: $hostname"
  cloudflared tunnel login | Out-Host

  if (Test-Path $certPath) { return }

  # Sometimes cloudflared cannot write cert.pem and the browser downloads it instead.
  $candidates = @()
  foreach ($dir in @(
    (Join-Path $env:USERPROFILE "Downloads"),
    (Join-Path $env:USERPROFILE "Desktop")
  )) {
    if (-not (Test-Path $dir)) { continue }
    $candidates += Get-ChildItem -Path $dir -Filter "cert.pem" -File -ErrorAction SilentlyContinue
    $candidates += Get-ChildItem -Path $dir -Filter "cert*.pem" -File -ErrorAction SilentlyContinue
  }
  $picked = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($picked) {
    New-Item -ItemType Directory -Force -Path $cloudflaredDir | Out-Null
    Copy-Item -Force -Path $picked.FullName -Destination $certPath
  }

  if (-not (Test-Path $certPath)) {
    throw "Login did not create cert.pem. If your browser downloaded it, copy it to: $certPath, then rerun tools\\cf_full_setup.ps1"
  }
}

function Get-OrCreate-TunnelId([string]$name) {
  $tunnels = cloudflared tunnel list --output json | ConvertFrom-Json
  $match = $tunnels | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if ($match) { return $match.id }

  Write-Host "Creating tunnel: $name"
  cloudflared tunnel create $name | Out-Host

  $tunnels2 = cloudflared tunnel list --output json | ConvertFrom-Json
  $match2 = $tunnels2 | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if (-not $match2) { throw "Tunnel created but not found in list: $name" }
  return $match2.id
}

function Ensure-DnsRoute([string]$name, [string]$dnsHostname) {
  # cloudflared often logs to stderr even on success. Don't let that fail the script.
  $prev = $ErrorActionPreference
  try {
    $ErrorActionPreference = "SilentlyContinue"
    cloudflared tunnel route dns --overwrite-dns $name $dnsHostname 2>$null | Out-Null
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($exit -ne 0) {
    Write-Host "DNS route note: route command returned non-zero; please check Cloudflare DNS records for this hostname."
  }
}

function Write-TunnelConfig([string]$name, [string]$id, [string]$publicHostname, [string]$localService) {
  $cloudflaredDir = Join-Path $HOME ".cloudflared"
  New-Item -ItemType Directory -Force -Path $cloudflaredDir | Out-Null

  $credFile = Join-Path $cloudflaredDir ($id + ".json")
  if (-not (Test-Path $credFile)) {
    throw "Credentials file not found: $credFile (did tunnel create succeed?)"
  }

  $configPath = Join-Path $cloudflaredDir ($name + ".yml")
  $credYamlPath = ($credFile -replace "\\", "/")
  $yaml = @"
tunnel: $id
credentials-file: "$credYamlPath"

ingress:
  - hostname: $publicHostname
    service: $localService
  - service: http_status:404
"@

  Set-Content -Path $configPath -Value $yaml -Encoding utf8
  return $configPath
}

Ensure-Cloudflared
Ensure-Login

$id = Get-OrCreate-TunnelId $tunnelName
Ensure-DnsRoute $tunnelName $hostname
$configPath = Write-TunnelConfig $tunnelName $id $hostname $service

Write-Host ""
Write-Host "Tunnel ready:"
Write-Host ("  tunnel name: " + $tunnelName)
Write-Host ("  hostname:    " + $hostname)
Write-Host ("  service:     " + $service)
Write-Host ("  config:      " + $configPath)
Write-Host ""
Write-Host "Next:"
Write-Host "  1) Run the app:        powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\run.ps1"
Write-Host ("  2) Run the tunnel:     cloudflared tunnel --config `"" + $configPath + "`" run")
Write-Host ("  3) Open:              https://" + $hostname)
Write-Host ""
Write-Host "Then protect it with Cloudflare Access (Email PIN): docs\\SHARE_WITH_TEAM.md"
