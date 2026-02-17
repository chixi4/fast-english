@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-openclaw-node.ps1" %*
echo.
echo Stop completed.
pause

