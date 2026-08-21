@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [Error] Node.js not found. Please install Node.js 18 or newer from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules\socket.io\package.json" (
    echo Installing dependencies, please wait...
    call npm install --omit=dev --no-audit --no-fund
    if errorlevel 1 (
        echo [Error] Dependency installation failed. Check your network and retry.
        pause
        exit /b 1
    )
)

for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c = Get-Content 'config.json' -Raw | ConvertFrom-Json; if ($c.port -is [int] -and $c.port -ge 1 -and $c.port -le 65535) { $c.port } else { 15151 } } catch { 15151 }"`) do set "CFG_PORT=%%P"
set "USE_PORT=%CFG_PORT%"

set "OLD_PIDS="
for /f "delims=" %%R in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$pids = @(Get-NetTCPConnection -LocalPort %CFG_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if ($pids.Count -gt 0) { $pids -join ',' }"`) do set "OLD_PIDS=%%R"

if defined OLD_PIDS (
    echo.
    echo [Warning] Port %CFG_PORT% is already in use by process ID: %OLD_PIDS%
    echo   K = kill the old process, then start on port %CFG_PORT%
    echo   A = keep it running and start this server on the next free port
    echo   any other key = quit
    set /p "CHOICE=Your choice: "
    if /i "!CHOICE!"=="K" (
        for %%X in (%OLD_PIDS%) do (
            taskkill /F /PID %%X >nul 2>nul
        )
        timeout /t 1 /nobreak >nul
    ) else if /i "!CHOICE!"=="A" (
        set "USE_PORT="
        powershell -NoProfile -ExecutionPolicy Bypass -Command "$base = %CFG_PORT%; for ($p = $base; $p -le $base + 100; $p++) { if (-not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { $p | Out-File -Encoding ascii -NoNewline '_mp_next_port.tmp'; exit 0 } }; exit 1"
        if exist "_mp_next_port.tmp" (
            set /p "USE_PORT=" < "_mp_next_port.tmp"
            del "_mp_next_port.tmp" >nul 2>nul
        )
        if not defined USE_PORT (
            echo [Error] No free port found near %CFG_PORT%.
            pause
            exit /b 1
        )
    ) else (
        echo Cancelled.
        pause
        exit /b 0
    )
)

echo.
echo Starting CrossCode Multiplayer server v1.73.0 on port %USE_PORT%...
echo Close this window or press Ctrl+C to stop the server.
set "PORT=%USE_PORT%"
node server.js
pause
