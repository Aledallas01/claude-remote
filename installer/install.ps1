# Claude Remote - Windows installer (per user, no administrator rights).
#   1. Node.js 18+ (installed with winget if missing)
#   2. the project (git clone when git is available, otherwise a zip of the main branch)
#   3. dependencies and the web UI build
#   4. Claude Code hooks (~/.claude/settings.json, backed up) and the tray app at login
# Re-running it updates an existing install. Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallDir <folder>] [-SkipHooks] [-SkipAutostart]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\ClaudeRemote'),
  [string]$Repo = 'Aledallas01/claude-remote',
  [string]$Branch = 'main',
  [switch]$SkipHooks,
  [switch]$SkipAutostart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host 'Claude Remote installer' -ForegroundColor Green
Write-Host "Install folder: $InstallDir"

Step 'Node.js'
$nodeOk = $false
if (Have 'node') {
  $v = (node -v) -replace '^v', ''
  if ([version]$v -ge [version]'18.0.0') { $nodeOk = $true; Write-Host "found Node.js $v" }
}
if (-not $nodeOk) {
  if (-not (Have 'winget')) { throw 'Node.js 18+ is required and winget is not available. Install Node.js from https://nodejs.org and run this installer again.' }
  Write-Host 'installing Node.js LTS with winget...'
  winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Refresh-Path
  if (-not (Have 'node')) { throw 'Node.js was installed but is not on the PATH yet: open a new terminal and run the installer again.' }
  Write-Host "installed Node.js $(node -v)"
}

Step 'Project files'
New-Item -ItemType Directory -Force (Split-Path -Parent $InstallDir) | Out-Null
if (Test-Path (Join-Path $InstallDir '.git')) {
  Write-Host 'existing git install: pulling the latest version'
  git -C $InstallDir pull --ff-only origin $Branch
} elseif (Have 'git') {
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Host 'cloning with git (updates will use git pull)'
  git clone --quiet --branch $Branch "https://github.com/$Repo.git" $InstallDir
} else {
  Write-Host 'git not found: downloading a zip of the latest version'
  $tmp = Join-Path $env:TEMP ('claude-remote-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $zip = Join-Path $tmp 'src.zip'
  Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extracted = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'claude-remote-*' } | Select-Object -First 1
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  robocopy $extracted.FullName $InstallDir /E /XD node_modules dist /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy failed ($LASTEXITCODE)" }
  $sha = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers @{ 'User-Agent' = 'claude-remote-installer' }).sha
  Set-Content -Path (Join-Path $InstallDir '.install-sha') -Value $sha
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Step 'Dependencies and web UI'
Push-Location (Join-Path $InstallDir 'agent')
try { npm install --no-audit --no-fund 2>&1 | Select-Object -Last 1 } finally { Pop-Location }
Push-Location (Join-Path $InstallDir 'web')
try { npm install --no-audit --no-fund 2>&1 | Select-Object -Last 1; npm run build 2>&1 | Select-Object -Last 1 } finally { Pop-Location }

if (-not $SkipHooks) {
  Step 'Claude Code hooks'
  Push-Location (Join-Path $InstallDir 'agent')
  try { node src\index.js --install-hooks } finally { Pop-Location }
}

if (-not $SkipAutostart) {
  Step 'Tray app at login'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'agent\autostart.ps1') -Install
}

Step 'Done'
Write-Host "Claude Remote is installed in $InstallDir"
Write-Host 'Look for the terracotta icon in the notification area: click it for the status window and the QR code.'
Write-Host 'On your phone open https://claude-remote-three.vercel.app, add it to the Home Screen and scan the QR code.'
