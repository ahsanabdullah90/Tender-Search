@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: Verify node_modules exists, install if missing on fresh clone
if not exist "node_modules\" (
    echo First-time setup detected. Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Command failed with exit code %errorlevel%.
        pause
        exit /b %errorlevel%
    )
)

:: Build production bundle on fresh clone or after clean
if not exist "dist\index.html" (
    echo Building production UI and server bundle...
    call npm run build
    if %errorlevel% neq 0 (
        echo [ERROR] Command failed with exit code %errorlevel%.
        pause
        exit /b %errorlevel%
    )
) else if not exist "dist-server\server.mjs" (
    echo Building compiled server bundle...
    call npm run build:server
    if %errorlevel% neq 0 (
        echo [ERROR] Command failed with exit code %errorlevel%.
        pause
        exit /b %errorlevel%
    )
)

if /i "%~1"=="--console" goto console_mode

:: Launch standalone desktop window + Windows system tray quietly
start "" wscript.exe "%~dp0scripts\launch-desktop.vbs" %*
exit /b 0

:console_mode
echo ========================================================
echo Starting Tender Tracker - Pakistan Procurement Watchdog
echo Solo-Operator Local Edition (http://localhost:3000)
echo ========================================================

:: Start browser once server is ready in background
start /min cmd /c "timeout /t 3 /nobreak >nul && start "" http://localhost:3000"

call npm start
pause
