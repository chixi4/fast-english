@echo off
setlocal

cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  set "PY=python"
)

echo This will wipe ALL local app data in the SQLite DB.
echo (Words, decks, reviews, mistakes, simulations)
echo.

set "DB=%APP_DB_PATH%"
if "%DB%"=="" set "DB=data\\app.db"
echo DB: %DB%
echo.
set /p CONFIRM=Type YES to continue: 
if /I not "%CONFIRM%"=="YES" (
  echo Cancelled.
  exit /b 1
)

"%PY%" tools\\reset_data.py "%DB%"

echo.
echo Done. You can restart the server and refresh the page.

