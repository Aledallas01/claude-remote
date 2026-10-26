# Installs or removes the per-user Startup shortcut that runs the agent in the background at
# every login. No administrator rights, no scheduled task: just a shortcut in
# %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup.
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status
)
$ErrorActionPreference = 'Stop'
$agentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$lnk = Join-Path $startup 'Claude Remote agent.lnk'
$vbs = Join-Path $agentDir 'start-hidden.vbs'

function Get-PidFrom([string]$name) {
  $pidFile = Join-Path $env:APPDATA ('claude-remote\' + $name)
  if (-not (Test-Path $pidFile)) { return $null }
  $id = 0
  if ([int]::TryParse((Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$id) -and $id -gt 0 -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { return $id }
  return $null
}
function Get-AgentPid { Get-PidFrom 'agent.pid' }
function Get-TrayPid { Get-PidFrom 'tray.pid' }

if ($Install) {
  New-Item -ItemType Directory -Force $startup | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = 'wscript.exe'
  $s.Arguments = '"' + $vbs + '"'
  $s.WorkingDirectory = $agentDir
  $s.Description = 'Claude Remote agent (runs in the background)'
  $s.Save()
  Write-Host "Installed: $lnk"
  Write-Host 'Claude Remote now starts in the background at every login (icon in the notification area).'
  if (-not (Get-TrayPid)) {
    Write-Host 'Starting it now...'
    Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $agentDir
    Start-Sleep -Seconds 8
  }
  Write-Host 'Click the tray icon for the status window and the QR code (or run  node src\index.js --link).'
  exit 0
}

if ($Uninstall) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed: $lnk" } else { Write-Host 'No Startup shortcut found.' }
  $tid = Get-TrayPid
  if ($tid) { Stop-Process -Id $tid -Force; Write-Host "Stopped the tray app (pid $tid)." }
  Start-Sleep -Seconds 1
  $id = Get-AgentPid
  if ($id) { Stop-Process -Id $id -Force; Write-Host "Stopped the background agent (pid $id)." }
  exit 0
}

# Status (default)
Write-Host ("Startup shortcut: " + $(if (Test-Path $lnk) { 'installed' } else { 'not installed' }))
$tid = Get-TrayPid
Write-Host ("Tray app: " + $(if ($tid) { "running (pid $tid)" } else { 'not running' }))
$id = Get-AgentPid
Write-Host ("Background agent: " + $(if ($id) { "running (pid $id)" } else { 'not running' }))
