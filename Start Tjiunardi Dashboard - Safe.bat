@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT_DIR=C:\Users\James\OneDrive\Documents\Tjiunardi Stock Research Gemini Dashboard\Tjiunardi-Dashboard-Viewer"
set "HOST=localhost"
set "PORT=5174"
set "APP_URL=http://%HOST%:%PORT%/"
set "WINDOW_TITLE=Tjiunardi Dashboard Dev Server"
set "WAIT_SECONDS=60"

call :banner
call :check_project || goto :error_exit
call :check_runtime || goto :error_exit

call :is_app_live
if !errorlevel! == 0 (
  echo The dashboard is already running at %APP_URL%
  start "" "%APP_URL%"
  goto :success_exit
)

call :is_port_busy
if !errorlevel! == 0 (
  echo Port %PORT% is already in use, but the dashboard did not respond at %APP_URL%
  echo Close the process using that port, or change the port in this batch file.
  goto :error_exit
)

if not exist "%PROJECT_DIR%\node_modules" (
  echo Dependencies are missing. Running npm install first...
  pushd "%PROJECT_DIR%"
  call npm install
  if errorlevel 1 (
    popd
    echo npm install failed.
    goto :error_exit
  )
  popd
)

echo Starting dev server in a separate window...
start "%WINDOW_TITLE%" /min cmd /k "cd /d ""%PROJECT_DIR%"" && npm run dev -- --host %HOST% --port %PORT%"

echo Waiting for the dashboard to be ready...
for /L %%I in (1,1,%WAIT_SECONDS%) do (
  call :is_app_live
  if !errorlevel! == 0 (
    echo Dashboard is ready at %APP_URL%
    start "" "%APP_URL%"
    goto :success_exit
  )
  timeout /t 1 /nobreak >nul
)

echo The server window was started, but the app did not become reachable within %WAIT_SECONDS% seconds.
echo Check the "%WINDOW_TITLE%" window for any errors.
goto :error_exit

:check_project
if not exist "%PROJECT_DIR%\package.json" (
  echo Project folder not found:
  echo %PROJECT_DIR%
  exit /b 1
)
exit /b 0

:check_runtime
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not installed or not on PATH.
  exit /b 1
)
exit /b 0

:is_port_busy
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$busy = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($busy) { exit 0 } else { exit 1 }"
exit /b %errorlevel%

:is_app_live
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -Uri '%APP_URL%' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }"
exit /b %errorlevel%

:banner
echo ============================================
echo   Tjiunardi Dashboard Safe Launcher
echo ============================================
echo.
exit /b 0

:error_exit
echo.
pause
exit /b 1

:success_exit
echo.
exit /b 0
