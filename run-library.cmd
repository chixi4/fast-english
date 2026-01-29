@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv" (
  python -m venv .venv
)

set "PY=%~dp0.venv\Scripts\python.exe"

"%PY%" -m pip install -r requirements.txt

REM If port 8000 is already in use, try to stop python processes listening on it.
powershell.exe -NoProfile -Command ^
  "$pids=@(); try{ $pids=(Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction Stop ^| Select-Object -ExpandProperty OwningProcess ^| Sort-Object -Unique) } catch {} ; foreach($pid in $pids){ try{ $p=Get-Process -Id $pid -ErrorAction Stop; if($p.ProcessName -match '^python'){ Stop-Process -Id $pid -Force -ErrorAction Stop } } catch {} }"

REM Start server in a separate window so we can open the browser automatically.
REM Note: In cmd, backslash does NOT escape quotes, so avoid \"...\".
start "Vocabulary Study" "%PY%" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

REM Wait for server to come up (poll /openapi.json) and ensure /library exists.
powershell.exe -NoProfile -Command ^
  "$ok=$false; for($i=0;$i -lt 80;$i++){ try { $j=(Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8000/openapi.json).Content; if($j -match '\"/library\"'){ $ok=$true; break } } catch {} ; Start-Sleep -Milliseconds 250 }; if(-not $ok){ Write-Host 'Server did not start or /library is missing. If you still see 404, stop other uvicorn processes (Ctrl+C) and rerun.'; exit 1 }"
if errorlevel 1 (
  pause
  exit /b 1
)

start "" "http://127.0.0.1:8000/library"
