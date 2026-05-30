# PostgreSQL SSH-Tunnel Keepalive
# Haelt den Tunnel localhost:15432 -> HP Mini PostgreSQL dauerhaft am Leben.
# Prueft alle 30 Sekunden und startet den Tunnel neu wenn er weggefallen ist.

$KeyFile  = Join-Path $env:USERPROFILE '.ssh\miniserver_key'
$Remote   = 'patri@100.68.148.46'
$TunPort  = 15432
$PgPort   = 5432
$LogDir   = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'pg-tunnel.log'

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $LogFile -Value $line
}

function Test-TunnelUp {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $async = $tcp.BeginConnect('127.0.0.1', $TunPort, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(1500, $false)
        $tcp.Close()
        return $ok
    } catch { return $false }
}

function Start-Tunnel {
    $args = @(
        '-N',
        '-L', "${TunPort}:127.0.0.1:${PgPort}",
        '-i', $KeyFile,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        $Remote
    )
    Start-Process -FilePath 'ssh' -ArgumentList $args -WindowStyle Hidden
    Write-Log 'Tunnel gestartet.'
}

Write-Log 'Keepalive-Script gestartet.'

while ($true) {
    if (-not (Test-TunnelUp)) {
        Write-Log 'Tunnel nicht erreichbar - starte neu...'
        Start-Tunnel
        Start-Sleep -Seconds 5
    }
    Start-Sleep -Seconds 30
}
