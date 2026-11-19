@echo off
setlocal
title Tender Tracker

:: Resolve project root from script directory
cd /d "%~dp0\.."

:: Optional foreground console mode for diagnostics (--console)
if /i "%~1"=="--console" goto console_mode

:: Build production client + compiled server bundle if missing
if not exist "dist\index.html" (
    echo Building production UI and server bundle...
    call npm run build
    if %errorlevel% neq 0 exit /b %errorlevel%
) else if not exist "dist-server\server.mjs" (
    echo Building compiled server bundle...
    call npm run build:server
    if %errorlevel% neq 0 exit /b %errorlevel%
)

:: Launch standalone desktop window + Windows system tray quietly
start "" wscript.exe "%~dp0launch-desktop.vbs" %*
exit /b 0

:console_mode
echo =======================================================================
echo              Tender Tracker - Solo-Operator Console
echo =======================================================================
echo.

:: Check if the server is already active on port 3000
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [Tender Tracker] Application is already running on http://127.0.0.1:3000.
    echo Opening browser...
    start http://127.0.0.1:3000
    timeout /t 2 >nul
    exit /b 0
)

:: Build production client + compiled server bundle if missing
if not exist "dist\index.html" (
    echo Building production UI and server bundle...
    call npm run build
) else if not exist "dist-server\server.mjs" (
    echo Building compiled server bundle...
    call npm run build:server
)

echo Starting server...
:: Spawn background browser waiter that opens the tab as soon as port 3000 responds
start "" powershell -WindowStyle Hidden -Command "$url = 'http://127.0.0.1:3000'; for ($i=0; $i -lt 30; $i++) { try { $r = [System.Net.WebRequest]::Create($url); $r.Timeout = 800; $resp = $r.GetResponse(); $resp.Close(); Start-Process $url; break } catch { Start-Sleep -Milliseconds 500 } }"

:: Start production server (use npm run dev for interactive development)
call npm start

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Tender Tracker stopped unexpectedly with exit code %errorlevel%.
    pause
)
