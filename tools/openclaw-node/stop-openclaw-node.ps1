param()

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

function Stop-ProcessTreeByPid {
    param([int]$ProcessId)
    cmd.exe /c "taskkill /PID $ProcessId /T /F" | Out-Null
}

$stopped = $false

$nodeProc = Get-RunningProcessFromPidFile -PidFile $NodePidFile
if ($nodeProc) {
    Write-Info "Stopping node host PID=$($nodeProc.Id)"
    Stop-ProcessTreeByPid -ProcessId $nodeProc.Id
    $stopped = $true
}
else {
    Write-WarnMsg "Node host is not running"
}

$sshProc = Get-RunningProcessFromPidFile -PidFile $SshPidFile
if ($sshProc) {
    Write-Info "Stopping SSH tunnel PID=$($sshProc.Id)"
    Stop-ProcessTreeByPid -ProcessId $sshProc.Id
    $stopped = $true
}
else {
    Write-WarnMsg "SSH tunnel is not running"
}

if (Test-Path $NodePidFile) {
    Remove-Item $NodePidFile -Force
}
if (Test-Path $SshPidFile) {
    Remove-Item $SshPidFile -Force
}

if ($stopped) {
    Write-Ok "Stopped openclaw node processes"
}
else {
    Write-Ok "No processes to stop"
}
