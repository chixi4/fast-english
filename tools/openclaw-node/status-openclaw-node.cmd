@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0status-openclaw-node.ps1" %*
echo.
pause

