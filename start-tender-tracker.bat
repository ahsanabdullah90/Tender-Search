@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================================
echo Starting Tender Tracker - Pakistan Procurement Watchdog
echo Solo-Operator Local Edition (http://localhost:3000)
echo ========================================================

:: Verify node_modules exists, install if missing on fresh clone
if not exist "node_modules\" (
    echo First-time setup detected. Installing dependencies...
    call npm install
)

:: Start browser once server is ready in background
start /min cmd /c "timeout /t 3 /nobreak >nul && start "" http://localhost:3000"

call npm run dev
pause
