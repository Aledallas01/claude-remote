@echo off
rem Makes the agent start in the background at every login (per-user Startup shortcut) and starts it now.
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js 18+ is required. Download it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
if exist ..\web\package.json if not exist ..\web\dist\index.html (
  echo Building the web UI for LAN / self-hosted access...
  pushd ..\web
  call npm install --no-audit --no-fund && call npm run build
  popd
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Install
echo.
node src\index.js --link
pause
