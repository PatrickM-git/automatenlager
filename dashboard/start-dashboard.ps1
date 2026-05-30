$ErrorActionPreference = 'Stop'

$DashboardDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 8787
$LogDir = Join-Path $DashboardDir 'logs'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---- PostgreSQL-Tunnel sicherstellen ----------------------------------------
# Startet den Keepalive-Task falls noch nicht aktiv (prueft Port 15432).
function Test-TunnelUp {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $async = $tcp.BeginConnect('127.0.0.1', 15432, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(1200, $false)
    $tcp.Close()
    return $ok
  } catch { return $false }
}

$tunnelScript = Join-Path $DashboardDir 'start-pg-tunnel.ps1'
$tunnelRunning = Get-ScheduledTask -TaskName 'Automatenlager PG-Tunnel' -ErrorAction SilentlyContinue
if (-not (Test-TunnelUp)) {
  # Keepalive noch nicht aktiv -> direkt als Hintergrundprozess starten
  Start-Process powershell.exe `
    -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tunnelScript`"" `
    -WindowStyle Hidden
  # Kurz warten bis Tunnel oben ist (max 10 Sekunden)
  $waited = 0
  while (-not (Test-TunnelUp) -and $waited -lt 10) {
    Start-Sleep -Seconds 1
    $waited++
  }
}

# ---- Dashboard starten -------------------------------------------------------
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $LogDir "dashboard-$timestamp.out.log"
$stderr = Join-Path $LogDir "dashboard-$timestamp.err.log"

Start-Process `
  -FilePath $node `
  -ArgumentList 'server.js' `
  -WorkingDirectory $DashboardDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr
