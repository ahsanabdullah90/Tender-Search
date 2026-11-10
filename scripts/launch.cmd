@echo off
setlocal
title Tender Tracker

:: Resolve project root from script directory
cd /d "%~dp0\.."

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

echo Starting server...
:: Spawn background browser waiter that opens the tab as soon as port 3000 responds
start "" powershell -WindowStyle Hidden -Command "$url = 'http://127.0.0.1:3000'; for ($i=0; $i -lt 30; $i++) { try { $r = [System.Net.WebRequest]::Create($url); $r.Timeout = 800; $resp = $r.GetResponse(); $resp.Close(); Start-Process $url; break } catch { Start-Sleep -Milliseconds 500 } }"

:: Start application with live console output
call npm run dev

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Tender Tracker stopped unexpectedly with exit code %errorlevel%.
    pause
)
