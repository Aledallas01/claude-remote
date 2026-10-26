# Claude Remote - Windows tray application.
# Runs the agent in the background, keeps it alive, and shows an icon in the notification area.
# Click the icon for a window with the connection status, the links and a QR code to scan.
# Start it with start-hidden.vbs (no console); needs -STA for the clipboard, which the VBS sets.
param([switch]$ShowWindow)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'Continue'
$agentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $env:APPDATA 'claude-remote'
$cfgPath = Join-Path $dataDir 'config.json'
$agentPidFile = Join-Path $dataDir 'agent.pid'
$trayPidFile = Join-Path $dataDir 'tray.pid'
$logFile = Join-Path $agentDir 'agent.log'
$webUrlDefault = 'https://claude-remote-three.vercel.app'

# One tray at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ClaudeRemoteTray')
if (-not $mutex.WaitOne(0, $false)) { exit 0 }
New-Item -ItemType Directory -Force $dataDir | Out-Null
Set-Content -Path $trayPidFile -Value $PID

$it = (Get-Culture).TwoLetterISOLanguageName -eq 'it'
$T = if ($it) { @{
  title = 'Claude Remote'; open = 'Apri pannello'; copy = 'Copia link'; site = 'Apri il sito'; log = 'Apri il log'
  restart = 'Riavvia agent'; quit = 'Esci'; status = 'Stato'; running = 'in esecuzione'; starting = 'avvio in corso…'
  stopped = 'non raggiungibile'; stable = 'Indirizzo stabile'; tunnel = 'Tunnel Cloudflare'; wifi = 'Stesso Wi-Fi'
  tailscale = 'Tailscale'; clients = 'Dispositivi collegati'; sessions = 'Sessioni indicizzate'; live = 'Chat vive sul PC'
  hooks = 'Hook Claude Code'; login = 'Login CLI'; push = 'Notifiche push'; yes = 'sì'; no = 'no'; installed = 'installati'
  notInstalled = 'non installati'; loggedIn = 'fatto'; notLoggedIn = 'non fatto (solo chat aperte sul PC)'
  qrFor = 'QR per'; scan = 'Inquadra il QR dal telefono (dentro l''app o con la fotocamera): si collega da solo.'
  copied = 'Link copiato negli appunti'; close = 'Chiudi'; version = 'Versione'; since = 'Attivo da'; none = 'nessuno'
  tip = 'Claude Remote: agent'; devices = 'dispositivi'
} } else { @{
  title = 'Claude Remote'; open = 'Open panel'; copy = 'Copy link'; site = 'Open the website'; log = 'Open log'
  restart = 'Restart agent'; quit = 'Quit'; status = 'Status'; running = 'running'; starting = 'starting…'
  stopped = 'not reachable'; stable = 'Stable address'; tunnel = 'Cloudflare tunnel'; wifi = 'Same Wi-Fi'
  tailscale = 'Tailscale'; clients = 'Connected devices'; sessions = 'Sessions indexed'; live = 'Live chats on the PC'
  hooks = 'Claude Code hooks'; login = 'CLI login'; push = 'Push notifications'; yes = 'yes'; no = 'no'; installed = 'installed'
  notInstalled = 'not installed'; loggedIn = 'done'; notLoggedIn = 'not done (only chats open on the PC)'
  qrFor = 'QR for'; scan = 'Scan the QR with your phone (inside the app or with the camera): it connects by itself.'
  copied = 'Link copied to the clipboard'; close = 'Close'; version = 'Version'; since = 'Up since'; none = 'none'
  tip = 'Claude Remote: agent'; devices = 'devices'
} }

function Read-Config { try { Get-Content $cfgPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $null } }
function Get-AgentPid {
  if (-not (Test-Path $agentPidFile)) { return $null }
  $id = 0
  if ([int]::TryParse((Get-Content $agentPidFile -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$id) -and $id -gt 0 -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { return $id }
  return $null
}
function Rotate-Log {
  try { if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) { Move-Item $logFile ($logFile + '.1') -Force } } catch {}
}
$script:lastStart = [datetime]::MinValue
function Start-Agent {
  if (((Get-Date) - $script:lastStart).TotalSeconds -lt 20) { return }
  $script:lastStart = Get-Date
  Rotate-Log
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('node src\index.js --no-hooks >> "' + $logFile + '" 2>&1') -WorkingDirectory $agentDir -WindowStyle Hidden | Out-Null
}
function Get-Status {
  $cfg = Read-Config
  if (-not $cfg) { return $null }
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add('x-claude-remote-secret', [string]$cfg.hookSecret)
    $json = $wc.DownloadString("http://127.0.0.1:$($cfg.port)/local/status")
    return ($json | ConvertFrom-Json)
  } catch { return $null }
}
function Get-QrImage([string]$kind) {
  $cfg = Read-Config
  if (-not $cfg) { return $null }
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add('x-claude-remote-secret', [string]$cfg.hookSecret)
    $bytes = $wc.DownloadData("http://127.0.0.1:$($cfg.port)/local/qr.png?kind=$kind&size=320")
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    return [System.Drawing.Image]::FromStream($ms)
  } catch { return $null }
}
function Stop-Agent {
  $cfg = Read-Config
  $done = $false
  if ($cfg) {
    try {
      $wc = New-Object System.Net.WebClient
      $wc.Headers.Add('x-claude-remote-secret', [string]$cfg.hookSecret)
      $null = $wc.UploadString("http://127.0.0.1:$($cfg.port)/local/shutdown", 'POST', '')
      $done = $true
    } catch {}
  }
  if (-not $done) { $id = Get-AgentPid; if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
}

# ---------- icon: a terracotta starburst, grey when the agent is down ----------
function New-TrayIcon([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $color
  $pen = New-Object System.Drawing.Pen $color, 4.2
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  for ($i = 0; $i -lt 8; $i++) {
    $a = $i * [math]::PI / 4
    $g.DrawLine($pen, [float](16 + 5 * [math]::Cos($a)), [float](16 + 5 * [math]::Sin($a)), [float](16 + 13 * [math]::Cos($a)), [float](16 + 13 * [math]::Sin($a)))
  }
  $g.FillEllipse($brush, 11, 11, 10, 10)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconOn = New-TrayIcon ([System.Drawing.Color]::FromArgb(217, 119, 87))
$iconOff = New-TrayIcon ([System.Drawing.Color]::FromArgb(140, 140, 140))

# ---------- window ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = $T.title
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(760, 540)
$form.MinimumSize = New-Object System.Drawing.Size(700, 520)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Icon = $iconOn
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)

$grid = New-Object System.Windows.Forms.TableLayoutPanel
$grid.Location = New-Object System.Drawing.Point(16, 16)
$grid.Size = New-Object System.Drawing.Size(390, 440)
$grid.ColumnCount = 2
$grid.RowCount = 0
$grid.AutoSize = $false
[void]$grid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 150)))
[void]$grid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$rows = @('status', 'version', 'since', 'stable', 'tunnel', 'wifi', 'tailscale', 'clients', 'sessions', 'live', 'hooks', 'login', 'push')
$values = @{}
foreach ($key in $rows) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $T[$key]
  $l.ForeColor = [System.Drawing.Color]::DimGray
  $l.AutoSize = $true
  $l.Margin = New-Object System.Windows.Forms.Padding(0, 4, 8, 4)
  $v = New-Object System.Windows.Forms.Label
  $v.Text = '…'
  $v.AutoSize = $true
  $v.MaximumSize = New-Object System.Drawing.Size(235, 0)
  $v.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 4)
  $grid.Controls.Add($l, 0, $grid.RowCount)
  $grid.Controls.Add($v, 1, $grid.RowCount)
  $grid.RowCount++
  $values[$key] = $v
}
$form.Controls.Add($grid)

$qrLabel = New-Object System.Windows.Forms.Label
$qrLabel.Text = $T.qrFor
$qrLabel.Location = New-Object System.Drawing.Point(430, 16)
$qrLabel.AutoSize = $true
$form.Controls.Add($qrLabel)

$combo = New-Object System.Windows.Forms.ComboBox
$combo.DropDownStyle = 'DropDownList'
$combo.Location = New-Object System.Drawing.Point(430, 40)
$combo.Size = New-Object System.Drawing.Size(310, 26)
$form.Controls.Add($combo)

$pic = New-Object System.Windows.Forms.PictureBox
$pic.Location = New-Object System.Drawing.Point(430, 76)
$pic.Size = New-Object System.Drawing.Size(310, 310)
$pic.SizeMode = 'Zoom'
$pic.BackColor = [System.Drawing.Color]::White
$pic.BorderStyle = 'FixedSingle'
$form.Controls.Add($pic)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = $T.scan
$hint.Location = New-Object System.Drawing.Point(430, 394)
$hint.Size = New-Object System.Drawing.Size(310, 60)
$hint.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($hint)

function New-Button([string]$text, [int]$x, [int]$y, [int]$w = 120) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, 30)
  $form.Controls.Add($b)
  return $b
}
$btnCopy = New-Button $T.copy 16 464 130
$btnSite = New-Button $T.site 152 464 130
$btnLog = New-Button $T.log 288 464 110
$btnRestart = New-Button $T.restart 16 500 130
$btnQuit = New-Button $T.quit 152 500 130
$btnClose = New-Button $T.close 620 500 120

$script:links = @()
$script:status = $null

function Current-Link {
  if ($combo.SelectedIndex -ge 0 -and $combo.SelectedIndex -lt $script:links.Count) { return $script:links[$combo.SelectedIndex] }
  return $null
}
function Refresh-Qr {
  $l = Current-Link
  if (-not $l) { $pic.Image = $null; return }
  $img = Get-QrImage $l.kind
  if ($img) { $old = $pic.Image; $pic.Image = $img; if ($old) { $old.Dispose() } }
}
function Fmt-Links($kind) {
  $m = @($script:links | Where-Object { $_.kind -eq $kind })
  if (-not $m.Count) { return $T.none }
  return (($m | ForEach-Object { $_.wsBase -replace '^wss?://', '' }) -join "`n")
}
function Refresh-Status {
  $s = Get-Status
  $script:status = $s
  if ($s) {
    $notify.Icon = $iconOn
    $notify.Text = ("{0} - {1} {2}" -f $T.tip, $s.clients, $T.devices).Substring(0, [Math]::Min(63, ("{0} - {1} {2}" -f $T.tip, $s.clients, $T.devices).Length))
    $values['status'].Text = $T.running
    $values['status'].ForeColor = [System.Drawing.Color]::SeaGreen
    $values['version'].Text = [string]$s.version
    $values['since'].Text = ([datetime]$s.startedAt).ToString('g')
    $script:links = @($s.links)
    $values['stable'].Text = Fmt-Links 'public'
    $values['tunnel'].Text = Fmt-Links 'tunnel'
    $values['wifi'].Text = Fmt-Links 'lan'
    $values['tailscale'].Text = Fmt-Links 'tailscale'
    $values['clients'].Text = [string]$s.clients
    $values['sessions'].Text = [string]$s.sessions
    $values['live'].Text = [string]$s.liveSessions
    $values['hooks'].Text = if ($s.hooks.installed) { $T.installed } else { $T.notInstalled }
    $values['login'].Text = if ($s.loggedIn -eq $true) { $T.loggedIn } elseif ($s.loggedIn -eq $false) { $T.notLoggedIn } else { '?' }
    $values['push'].Text = "$($s.pushSubscriptions) $($T.devices)"
    $sel = $combo.SelectedIndex
    $combo.Items.Clear()
    foreach ($l in $script:links) { [void]$combo.Items.Add($l.label) }
    if ($combo.Items.Count -gt 0) { $combo.SelectedIndex = [Math]::Max(0, [Math]::Min($sel, $combo.Items.Count - 1)) }
    if ($form.Visible) { Refresh-Qr }
  } else {
    $notify.Icon = $iconOff
    $notify.Text = "$($T.tip): $($T.stopped)"
    $values['status'].Text = if (Get-AgentPid) { $T.starting } else { $T.stopped }
    $values['status'].ForeColor = [System.Drawing.Color]::Firebrick
    # Watchdog: bring the agent back.
    if (-not (Get-AgentPid)) { Start-Agent }
  }
}

$combo.Add_SelectedIndexChanged({ Refresh-Qr })
$btnCopy.Add_Click({ $l = Current-Link; if ($l) { [System.Windows.Forms.Clipboard]::SetText($l.url); $notify.ShowBalloonTip(2000, $T.title, $T.copied, [System.Windows.Forms.ToolTipIcon]::Info) } })
$btnSite.Add_Click({ $l = Current-Link; $u = if ($l) { $l.url } else { $webUrlDefault }; Start-Process $u })
$btnLog.Add_Click({ if (Test-Path $logFile) { Start-Process notepad.exe $logFile } })
$btnRestart.Add_Click({ Stop-Agent; Start-Sleep -Milliseconds 800; $script:lastStart = [datetime]::MinValue; Start-Agent; $values['status'].Text = $T.starting })
$btnClose.Add_Click({ $form.Hide() })
$form.Add_FormClosing({ param($s, $e) if ($e.CloseReason -eq 'UserClosing') { $e.Cancel = $true; $form.Hide() } })
$form.Add_Shown({ Refresh-Status; Refresh-Qr })

function Show-Panel { Refresh-Status; $form.Show(); $form.WindowState = 'Normal'; $form.Activate(); Refresh-Qr }

# ---------- tray icon + menu ----------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconOff
$notify.Text = $T.tip
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$mOpen = $menu.Items.Add($T.open); $mOpen.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
$mCopy = $menu.Items.Add($T.copy)
$mSite = $menu.Items.Add($T.site)
$mLog = $menu.Items.Add($T.log)
[void]$menu.Items.Add('-')
$mRestart = $menu.Items.Add($T.restart)
$mQuit = $menu.Items.Add($T.quit)
$notify.ContextMenuStrip = $menu
$mOpen.Add_Click({ Show-Panel })
$mCopy.Add_Click({ Refresh-Status; $l = Current-Link; if (-not $l -and $script:links.Count) { $l = $script:links[0] }; if ($l) { [System.Windows.Forms.Clipboard]::SetText($l.url); $notify.ShowBalloonTip(2000, $T.title, $T.copied, [System.Windows.Forms.ToolTipIcon]::Info) } })
$mSite.Add_Click({ Refresh-Status; $l = Current-Link; $u = if ($l) { $l.url } else { $webUrlDefault }; Start-Process $u })
$mLog.Add_Click({ if (Test-Path $logFile) { Start-Process notepad.exe $logFile } })
$mRestart.Add_Click({ Stop-Agent; Start-Sleep -Milliseconds 800; $script:lastStart = [datetime]::MinValue; Start-Agent })
$mQuit.Add_Click({ $timer.Stop(); Stop-Agent; $notify.Visible = $false; $notify.Dispose(); [System.Windows.Forms.Application]::Exit() })
$notify.Add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-Panel } })
$notify.Add_DoubleClick({ Show-Panel })

# ---------- run ----------
if (-not (Get-AgentPid)) { Start-Agent }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Refresh-Status })
$timer.Start()
Refresh-Status
if ($ShowWindow) { Show-Panel }
try {
  [System.Windows.Forms.Application]::Run()
} finally {
  try { $notify.Visible = $false; $notify.Dispose() } catch {}
  try { Remove-Item $trayPidFile -ErrorAction SilentlyContinue } catch {}
  $mutex.ReleaseMutex() | Out-Null
}
