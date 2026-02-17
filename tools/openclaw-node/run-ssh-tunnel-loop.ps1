param(
    [string]$ServerHost,
    [string]$ServerUser = "root",
    [string]$SshKeyPath,
    [int]$LocalForwardPort = 18790,
    [int]$RemoteGatewayPort = 18789,
    [int]$RetrySeconds = 2
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($ServerHost)) {
    throw "ServerHost is required"
}

if ([string]::IsNullOrWhiteSpace($SshKeyPath)) {
    throw "SshKeyPath is required"
}

if (-not (Test-Path $SshKeyPath)) {
    throw "SSH private key not found: $SshKeyPath"
}

Write-Output "ssh tunnel loop started at $(Get-Date -Format o)"
Write-Output "ssh tunnel target: 127.0.0.1:${LocalForwardPort} -> ${ServerHost}:${RemoteGatewayPort}"

while ($true) {
    $startedAt = Get-Date
    $exitCode = $null

    $sshArgs = @(
        "-NT",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=20",
        "-o", "ServerAliveCountMax=3",
        "-o", "TCPKeepAlive=yes",
        "-L", "${LocalForwardPort}:127.0.0.1:${RemoteGatewayPort}",
        "-i", $SshKeyPath,
        "$ServerUser@$ServerHost"
    )

    try {
        & ssh.exe @sshArgs
        $exitCode = $LASTEXITCODE
    }
    catch {
        $exitCode = 1
        $err = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($err)) {
            Write-Error $err
        }
    }

    $endedAt = Get-Date
    $duration = [int][Math]::Round((New-TimeSpan -Start $startedAt -End $endedAt).TotalSeconds)
    Write-Output "ssh tunnel ended at $($endedAt.ToString('o')), code=$exitCode, duration_sec=$duration"
    Start-Sleep -Seconds $RetrySeconds
}

