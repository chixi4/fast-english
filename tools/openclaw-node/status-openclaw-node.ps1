param(
    [string]$ServerHost = "47.254.195.180",
    [string]$ServerUser = "root",
    [string]$SshKeyPath = "$HOME\.ssh\fast-english_ed25519_20260204_220739",
    [int]$LocalForwardPort = 18790
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $ScriptDir ".state"
$SshPidFile = Join-Path $StateDir "ssh-tunnel.pid"
$NodePidFile = Join-Path $StateDir "node-host.pid"

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[OK]   $Message" -ForegroundColor Green
}

function Write-WarnMsg {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Get-RunningProcessFromPidFile {
    param([string]$PidFile)

    if (-not (Test-Path $PidFile)) {
        return $null
    }

    $pidText = (Get-Content $PidFile -Raw).Trim()
    if (-not ($pidText -match "^\d+$")) {
        return $null
    }

    try {
        return Get-Process -Id ([int]$pidText) -ErrorAction Stop
    }
    catch {
        return $null
    }
}

Write-Info "Local process status"
$nodeProc = Get-RunningProcessFromPidFile -PidFile $NodePidFile
$sshProc = Get-RunningProcessFromPidFile -PidFile $SshPidFile

if ($nodeProc) {
    Write-Ok "Node host running, PID=$($nodeProc.Id)"
}
else {
    Write-WarnMsg "Node host not running"
}

if ($sshProc) {
    Write-Ok "SSH tunnel running, PID=$($sshProc.Id)"
}
else {
    Write-WarnMsg "SSH tunnel not running"
}

$portReady = Test-NetConnection -ComputerName 127.0.0.1 -Port $LocalForwardPort -WarningAction SilentlyContinue
if ($portReady.TcpTestSucceeded) {
    Write-Ok "Local forward port ready: 127.0.0.1:$LocalForwardPort"
}
else {
    Write-WarnMsg "Local forward port NOT ready: 127.0.0.1:$LocalForwardPort"
}

Write-Info "Server node status"
ssh -i $SshKeyPath "$ServerUser@$ServerHost" "docker exec lobster-openclaw-openclaw-gateway-1 openclaw nodes status --json" | Out-Host
