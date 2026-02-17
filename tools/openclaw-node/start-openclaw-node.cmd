@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-openclaw-node.ps1" %*
if errorlevel 1 (
  echo.
  echo Start failed. Check logs in tools\openclaw-node\logs.
  pause
  exit /b 1
)
echo.
echo Start completed.
pause

