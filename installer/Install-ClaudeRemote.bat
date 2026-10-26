@echo off
rem Double-click to install Claude Remote for the current user (downloads the project, installs
rem Node.js if missing, the Claude Code hooks and the tray app at login).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
