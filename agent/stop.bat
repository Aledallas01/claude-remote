@echo off
rem Stops the tray application and the background agent.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = Join-Path $env:APPDATA 'claude-remote'; foreach ($n in 'tray.pid','agent.pid') { $f = Join-Path $d $n; if (Test-Path $f) { $id = 0; if ([int]::TryParse((Get-Content $f | Select-Object -First 1), [ref]$id) -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { Stop-Process -Id $id -Force; Write-Host \"Stopped $n (pid $id).\" } } }; Write-Host 'Done.'"
pause
