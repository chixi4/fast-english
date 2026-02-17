param(
    [string]$GatewayToken,
    [string]$GatewayHost = "127.0.0.1",
    [int]$Port = 18790,
    [string]$DisplayName = "$env:COMPUTERNAME",
    [int]$RetrySeconds = 2
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($GatewayToken)) {
    throw "GatewayToken is required"
}

$env:OPENCLAW_GATEWAY_TOKEN = $GatewayToken
Write-Output "node host loop started at $(Get-Date -Format o)"
Write-Output "node target: ${GatewayHost}:$Port"
Write-Output "node display: $DisplayName"

while ($true) {
    $startedAt = Get-Date
    $exitCode = $null

    try {
        & openclaw node run --host $GatewayHost --port $Port --display-name $DisplayName
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
    Write-Output "node run ended at $($endedAt.ToString('o')), code=$exitCode, duration_sec=$duration"

    Start-Sleep -Seconds $RetrySeconds
}
