@echo off
setlocal
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
rem Build the web UI once so the agent can serve it itself (LAN / Tailscale links need no other host).
if exist ..\web\package.json if not exist ..\web\dist\index.html (
  echo Building the web UI for LAN / self-hosted access...
  pushd ..\web
  call npm install --no-audit --no-fund && call npm run build
  popd
)
node src\index.js %*
pause
