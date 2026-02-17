param(
    [string]$ServerHost = "47.254.195.180",
    [string]$ServerUser = "root",
    [string]$SshKeyPath = "$HOME\.ssh\fast-english_ed25519_20260204_220739",
    [int]$LocalForwardPort = 18790,
    [int]$RemoteGatewayPort = 18789,
    [string]$DisplayName = "$env:COMPUTERNAME",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $ScriptDir ".state"
$LogDir = Join-Path $ScriptDir "logs"
$SshLoopScript = Join-Path $ScriptDir "run-ssh-tunnel-loop.ps1"
$NodeLoopScript = Join-Path $ScriptDir "run-openclaw-node-loop.ps1"
$SshPidFile = Join-Path $StateDir "ssh-tunnel.pid"
$NodePidFile = Join-Path $StateDir "node-host.pid"
$SshOutLog = Join-Path $LogDir "ssh.stdout.log"
$SshErrLog = Join-Path $LogDir "ssh.stderr.log"
$NodeOutLog = Join-Path $LogDir "node.stdout.log"
$NodeErrLog = Join-Path $LogDir "node.stderr.log"

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

function Ensure-Path {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Test-LocalPortReady {
    param([int]$Port)

    for ($i = 0; $i -lt 60; $i++) {
        $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue
        if ($ok.TcpTestSucceeded) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Approve-PendingDeviceRequests {
    param(
        [string]$ServerAddress,
        [string]$User,
        [string]$KeyPath
    )

    $listJson = ssh -i $KeyPath "$User@$ServerAddress" "docker exec lobster-openclaw-openclaw-gateway-1 openclaw devices list --json"
    if (-not $listJson) {
        return 0
    }

    $approvedCount = 0
    $parsed = $listJson | ConvertFrom-Json
    $pending = @()
    if ($parsed -and $parsed.PSObject.Properties.Name -contains "pending") {
        $pending = @($parsed.pending)
    }

    foreach ($item in $pending) {
        $requestId = $null
        if ($item.PSObject.Properties.Name -contains "requestId") {
            $requestId = $item.requestId
        }
        if ($requestId) {
            Write-Info "Approving device request: $requestId"
            ssh -i $KeyPath "$User@$ServerAddress" "docker exec lobster-openclaw-openclaw-gateway-1 openclaw devices approve $requestId --json" | Out-Host
            $approvedCount++
        }
    }

    return $approvedCount
}

Ensure-Path $StateDir
Ensure-Path $LogDir

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw "ssh.exe not found"
}

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
    throw "openclaw command not found"
}

if (-not (Test-Path $NodeLoopScript)) {
    throw "Node loop script not found: $NodeLoopScript"
}

if (-not (Test-Path $SshLoopScript)) {
    throw "SSH loop script not found: $SshLoopScript"
}

if (-not (Test-Path $SshKeyPath)) {
    throw "SSH private key not found: $SshKeyPath"
}

$existingSsh = Get-RunningProcessFromPidFile -PidFile $SshPidFile
$existingNode = Get-RunningProcessFromPidFile -PidFile $NodePidFile

if (-not $Restart -and $existingSsh -and $existingNode) {
    Write-WarnMsg "Node host already running and healthy. Use -Restart to restart."
    exit 0
}

if ($Restart -or $existingNode -or $existingSsh) {
    if ($existingNode) {
        Write-Info "Stopping old node process PID=$($existingNode.Id)"
        Stop-ProcessTreeByPid -ProcessId $existingNode.Id
    }
    if ($existingSsh) {
        Write-Info "Stopping old tunnel process PID=$($existingSsh.Id)"
        Stop-ProcessTreeByPid -ProcessId $existingSsh.Id
    }
}

Write-Info "Reading gateway token from server"
$tokenCommand = "docker exec lobster-openclaw-openclaw-gateway-1 openclaw config get gateway.auth.token"
$gatewayToken = (ssh -i $SshKeyPath "$ServerUser@$ServerHost" $tokenCommand).Trim()

if (-not $gatewayToken) {
    throw "Failed to read gateway token"
}

Write-Info "Starting SSH tunnel 127.0.0.1:${LocalForwardPort} -> ${ServerHost}:${RemoteGatewayPort}"
$sshLoopArgs = @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $SshLoopScript,
    "-ServerHost", $ServerHost,
    "-ServerUser", $ServerUser,
    "-SshKeyPath", $SshKeyPath,
    "-LocalForwardPort", "$LocalForwardPort",
    "-RemoteGatewayPort", "$RemoteGatewayPort",
    "-RetrySeconds", "2"
)

$sshProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $sshLoopArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $SshOutLog -RedirectStandardError $SshErrLog
Start-Sleep -Seconds 2

if ($sshProcess.HasExited) {
    throw "SSH tunnel start failed. See: $SshErrLog"
}

if (-not (Test-LocalPortReady -Port $LocalForwardPort)) {
    Stop-ProcessTreeByPid -ProcessId $sshProcess.Id
    throw "Local forward port $LocalForwardPort is not ready. See: $SshErrLog"
}

$sshProcess.Id | Set-Content -Path $SshPidFile -Encoding ascii
Write-Ok "SSH tunnel ready, PID=$($sshProcess.Id)"

Write-Info "Starting local node host, display name: $DisplayName"
$nodeArgs = @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $NodeLoopScript,
    "-GatewayToken", $gatewayToken,
    "-GatewayHost", "127.0.0.1",
    "-Port", "$LocalForwardPort",
    "-DisplayName", $DisplayName,
    "-RetrySeconds", "2"
)

$nodeProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $nodeArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $NodeOutLog -RedirectStandardError $NodeErrLog
Start-Sleep -Seconds 3

if ($nodeProcess.HasExited) {
    Write-WarnMsg "Node host loop exited early. Trying auto-approve flow."
    $approved = Approve-PendingDeviceRequests -ServerAddress $ServerHost -User $ServerUser -KeyPath $SshKeyPath
    if ($approved -gt 0) {
        Write-Info "Restarting node host loop after approval"
        $nodeProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $nodeArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $NodeOutLog -RedirectStandardError $NodeErrLog
        Start-Sleep -Seconds 3
    }
}

if ($nodeProcess.HasExited) {
    throw "Node host loop start failed. See: $NodeErrLog"
}

$nodeProcess.Id | Set-Content -Path $NodePidFile -Encoding ascii
Write-Ok "Node host started, PID=$($nodeProcess.Id)"

Write-Info "Checking pending device requests"
$approvedNow = Approve-PendingDeviceRequests -ServerAddress $ServerHost -User $ServerUser -KeyPath $SshKeyPath
if ($approvedNow -eq 0) {
    Write-Info "No pending device requests"
}

Write-Info "Current server node status"
ssh -i $SshKeyPath "$ServerUser@$ServerHost" "docker exec lobster-openclaw-openclaw-gateway-1 openclaw nodes status --json" | Out-Host

Write-Ok "One-click start finished"
Write-Host ""
Write-Host "Start:  $ScriptDir\start-openclaw-node.cmd"
Write-Host "Stop:   $ScriptDir\stop-openclaw-node.cmd"
Write-Host "Status: $ScriptDir\status-openclaw-node.cmd"
