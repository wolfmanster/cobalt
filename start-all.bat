@echo off
setlocal EnableExtensions

rem Start the local services from the directory containing this file.
cd /d "%~dp0"

set "START_SCRIPT=%~dp0start-all.ps1"
set "APP_URL=http://127.0.0.1:4100"

if not exist "%START_SCRIPT%" (
    echo [ERROR] start-all.ps1 was not found:
    echo         "%START_SCRIPT%"
    pause
    exit /b 1
)

echo Starting the services...
start "X media archive services" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%START_SCRIPT%"

echo Waiting for the web service at %APP_URL% ...
set /a RETRIES=0

:wait_for_service
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%APP_URL%/api/health' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } } catch {} exit 1" ^
    >nul 2>&1

if not errorlevel 1 goto service_ready

set /a RETRIES+=1
if %RETRIES% GEQ 30 goto service_timeout
timeout /t 1 /nobreak >nul
goto wait_for_service

:service_ready
echo Service is ready. Opening the browser...
start "" "%APP_URL%"
exit /b 0

:service_timeout
echo [WARN] The service did not respond within 30 seconds.
echo        Opening %APP_URL% anyway. Check the PowerShell window for errors.
start "" "%APP_URL%"
pause
exit /b 1
