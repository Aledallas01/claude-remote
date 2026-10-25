@echo off
rem Removes the Startup shortcut and stops the background agent.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Uninstall
pause
