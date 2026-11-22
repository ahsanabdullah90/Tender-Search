@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "APP_PORT=%PORT%"
if "%APP_PORT%"=="" set "APP_PORT=3000"

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
call :ensure_build
if %errorlevel% neq 0 (
    echo [ERROR] Command failed with exit code %errorlevel%.
    pause
    exit /b %errorlevel%
)

if /i "%~1"=="--console" goto console_mode

:: Launch standalone desktop window + Windows system tray quietly
start "" wscript.exe "%~dp0scripts\launch-desktop.vbs" %*
exit /b 0

:console_mode
echo ========================================================
echo Starting Tender Tracker - Pakistan Procurement Watchdog
echo Solo-Operator Local Edition (http://127.0.0.1:%APP_PORT%)
echo ========================================================

:: Start browser once server responds on configured port
start "" powershell -WindowStyle Hidden -Command "$url = 'http://127.0.0.1:%APP_PORT%'; for ($i=0; $i -lt 30; $i++) { try { $r = [System.Net.WebRequest]::Create($url); $r.Timeout = 800; $resp = $r.GetResponse(); $resp.Close(); Start-Process $url; break } catch { Start-Sleep -Milliseconds 500 } }"

call npm start
pause
exit /b %errorlevel%

:ensure_build
if not exist "dist\index.html" (
    echo Building production UI and server bundle...
    call npm run build
    exit /b %errorlevel%
) else if not exist "dist-server\server.mjs" (
    echo Building compiled server bundle...
    call npm run build:server
    exit /b %errorlevel%
)
exit /b 0
