$ErrorActionPreference = "Stop"

Set-Location -Path (Resolve-Path (Join-Path $PSScriptRoot ".."))

function New-RandomSecret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $b64 = [Convert]::ToBase64String($bytes).TrimEnd("=")
  return ($b64 -replace "\\+", "-" -replace "/", "_")
}

function Upsert-EnvVar([string[]]$lines, [string]$key, [string]$value) {
  $pattern = "^\s*" + [Regex]::Escape($key) + "\s*="
  $found = $false
  $out = @()
  foreach ($line in $lines) {
    if ($line -match $pattern) {
      $out += ($key + "=" + $value)
      $found = $true
    } else {
      $out += $line
    }
  }
  if (-not $found) {
    if ($out.Count -gt 0 -and ($out[-1].Trim() -ne "")) {
      $out += ""
    }
    $out += ($key + "=" + $value)
  }
  return ,$out
}

function Get-EnvVar([string[]]$lines, [string]$key) {
  $pattern = "^\s*" + [Regex]::Escape($key) + "\s*=(.*)$"
  foreach ($line in $lines) {
    if ($line -match $pattern) {
      $v = $Matches[1]
      if ($null -eq $v) { $v = "" }
      return $v.Trim()
    }
  }
  return $null
}

if (-not (Test-Path ".env")) {
  if (Test-Path ".env.example") {
    Copy-Item -Force ".env.example" ".env"
    Write-Host "Created .env from .env.example"
  } else {
    New-Item -ItemType File -Path ".env" -Force | Out-Null
    Write-Host "Created empty .env"
  }
}

$lines = Get-Content ".env"

# Enable in-app login + per-user storage by default.
$lines = Upsert-EnvVar $lines "APP_REQUIRE_LOGIN" "1"
$lines = Upsert-EnvVar $lines "APP_MULTIUSER_BY_IDENTITY" "1"
$lines = Upsert-EnvVar $lines "APP_USER_DB_DIR" "data/userdb"
$lines = Upsert-EnvVar $lines "APP_AUTH_DB_PATH" "data/auth.db"
$lines = Upsert-EnvVar $lines "APP_AUTH_COOKIE_NAME" "vs_session"
$lines = Upsert-EnvVar $lines "APP_AUTH_COOKIE_DAYS" "30"

$secret = Get-EnvVar $lines "APP_AUTH_SECRET_KEY"
if (-not $secret -or $secret -eq "change-me-long-random") {
  $newSecret = New-RandomSecret
  $lines = Upsert-EnvVar $lines "APP_AUTH_SECRET_KEY" $newSecret
  Write-Host "Generated APP_AUTH_SECRET_KEY"
}

Set-Content -Path ".env" -Value $lines -Encoding utf8
Write-Host "Updated .env"
