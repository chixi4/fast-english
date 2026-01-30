@echo off
setlocal

cd /d %~dp0

REM Defaults (edit if you use a different domain/tunnel)
set "CLOUDFLARED_TUNNEL_NAME=vocabulary-study"
set "CLOUDFLARED_HOSTNAME=yuookie.qzz.io"
set "CLOUDFLARED_SERVICE=http://127.0.0.1:8000"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ensure_env.ps1
if errorlevel 1 (
  echo ensure_env.ps1 failed.
  pause
  exit /b 1
)

REM This will open a browser for Cloudflare login if needed, then start app + tunnel.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\one_click_share.ps1
if errorlevel 1 (
  echo one_click_share.ps1 failed.
  pause
  exit /b 1
)

