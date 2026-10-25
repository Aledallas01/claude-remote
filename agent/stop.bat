@echo off
rem Stops the agent running in the background (the one started by start-hidden.vbs / autostart).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Join-Path $env:APPDATA 'claude-remote\agent.pid'; if (Test-Path $f) { $id = [int](Get-Content $f | Select-Object -First 1); if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force; Write-Host \"Stopped the agent (pid $id).\" } else { Write-Host 'The agent is not running.' } } else { Write-Host 'The agent is not running.' }"
pause
