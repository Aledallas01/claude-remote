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
node src\index.js %*
pause
