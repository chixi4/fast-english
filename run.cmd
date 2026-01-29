@echo off
setlocal

cd /d %~dp0

if not exist ".venv" (
  python -m venv .venv
)

".\\.venv\\Scripts\\python.exe" -m pip install -r requirements.txt

REM python-dotenv will load .env automatically in app.main
".\\.venv\\Scripts\\python.exe" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

