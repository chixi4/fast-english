param(
  [string]$Url = "https://yuookie.qzz.io/",
  [string]$Profile = "real-mobile-bug",
  [string]$Device = "Pixel 7",
  [switch]$Headless,
  [int]$RunSeconds = 0,
  [switch]$NoVideo,
  [int]$WindowWidth = 560,
  [int]$WindowHeight = 1100
)

$ErrorActionPreference = "Stop"
Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -Path ".."

$python = Join-Path "." ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  $python = "python"
}

$args = @("tools/desktop_visual_debug.py", "--url", $Url, "--profile", $Profile, "--device", $Device)
if ($Headless) { $args += "--headless" }
if ($RunSeconds -gt 0) { $args += @("--run-seconds", "$RunSeconds") }
if ($NoVideo) { $args += "--no-video" }
if (-not $Headless) { $args += @("--window-width", "$WindowWidth", "--window-height", "$WindowHeight") }
if (-not $Headless) { $args += "--stop-on-enter" }

Write-Host "[visual-debug] started" -ForegroundColor Cyan
Write-Host "  url: $Url"
Write-Host "  profile: $Profile"
Write-Host "  device: $Device"
Write-Host "  headless: $($Headless.IsPresent)"
Write-Host "  no-video: $($NoVideo.IsPresent)"
if ($RunSeconds -gt 0) {
  Write-Host "  run-seconds: $RunSeconds (will auto-exit; press Enter to finish earlier)"
} else {
  Write-Host "  run-seconds: 0 (close browser or press Enter to finish)"
}
Write-Host "[visual-debug] running..." -ForegroundColor Yellow
if (-not $Headless) {
  Write-Host "[visual-debug] tip: 在此终端按 Enter 可立即结束" -ForegroundColor DarkYellow
}

& $python @args
