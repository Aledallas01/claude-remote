# Update check / apply for Claude Remote. Used by the tray app (automatic, every few hours) and
# usable by hand:  powershell -File update.ps1 -Check   or   -Apply
# Git installs are pulled (fast-forward only); zip installs download the latest main branch
# and copy it over, remembering the commit in .install-sha. Dependencies are reinstalled and
# the web UI is rebuilt. Nothing here touches the configuration or the token.
param(
  [switch]$Check,
  [switch]$Apply,
  [string]$Repo = 'Aledallas01/claude-remote',
  [string]$Branch = 'main'
)
$ErrorActionPreference = 'Stop'
$agentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $agentDir
$shaFile = Join-Path $root '.install-sha'
$isGit = Test-Path (Join-Path $root '.git')

function Get-LocalSha {
  if ($isGit) { try { return (git -C $root rev-parse HEAD 2>$null).Trim() } catch { return '' } }
  if (Test-Path $shaFile) { return (Get-Content $shaFile -Raw).Trim() }
  return ''
}
function Get-RemoteSha {
  $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers @{ 'User-Agent' = 'claude-remote-updater'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 20
  return [string]$r.sha
}

$local = Get-LocalSha
$remote = Get-RemoteSha
$available = ($remote -and $local -ne $remote)

if ($Check -or -not $Apply) {
  [pscustomobject]@{ local = $local; remote = $remote; updateAvailable = $available; method = $(if ($isGit) { 'git' } else { 'zip' }) } | ConvertTo-Json -Compress
  exit 0
}

if (-not $available) { Write-Host 'Already up to date.'; exit 0 }

Write-Host "Updating $local -> $remote ($(if ($isGit) { 'git pull' } else { 'zip download' }))"
if ($isGit) {
  git -C $root fetch --quiet origin $Branch
  git -C $root pull --ff-only --quiet origin $Branch
} else {
  $tmp = Join-Path $env:TEMP ('claude-remote-update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $zip = Join-Path $tmp 'src.zip'
  Invoke-WebRequest -Uri "https://github.com/$Repo/archive/$remote.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 120
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extracted = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'claude-remote-*' } | Select-Object -First 1
  if (-not $extracted) { throw 'unexpected archive layout' }
  # Copy the new tree over the install, keeping node_modules and build output.
  robocopy $extracted.FullName $root /E /XD node_modules dist .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
  Set-Content -Path $shaFile -Value $remote
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Push-Location (Join-Path $root 'agent')
try { npm install --no-audit --no-fund 2>&1 | Out-Null } finally { Pop-Location }
$web = Join-Path $root 'web'
if (Test-Path (Join-Path $web 'package.json')) {
  Push-Location $web
  try { npm install --no-audit --no-fund 2>&1 | Out-Null; npm run build 2>&1 | Out-Null } finally { Pop-Location }
}
Write-Host "Updated to $remote"
