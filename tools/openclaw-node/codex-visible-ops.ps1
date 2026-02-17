param(
    [ValidateSet("peek", "ask", "new")]
    [string]$Action = "peek",
    [string]$Text,
    [string]$Workdir = "D:\dev\vocabulary-study",
    [string]$RouteWorkdir = "",
    [string]$WindowQuery = "gpt-5.3-codex",
    [Int64]$WindowHwnd = 0,
    [int]$WindowPid = 0,
    [int]$WindowPadding = 10,
    [int]$TailLines = 1200,
    [int]$PollIntervalMs = 1200,
    [int]$PollMaxTries = 10,
    [int]$MaxWaitSeconds = 180,
    [string]$RequireCompletion = "true"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowControlScript = Join-Path $ScriptDir "codex-window-control.ps1"
$StateDir = Join-Path $ScriptDir ".state"
$ActiveWindowFile = Join-Path $StateDir "codex-active-window.json"
$WindowBindingsFile = Join-Path $StateDir "codex-window-bindings.json"
$DefaultWorkdir = "D:\dev\vocabulary-study"
$FreshnessMaxAgeSeconds = 60

function New-Result {
    param(
        [bool]$Ok,
        [string]$ActionName,
        [object]$Data,
        [string]$ErrorMessage,
        [int]$ExitCode = 0
    )

    $obj = [ordered]@{
        ok = $Ok
        action = $ActionName
        exit_code = $ExitCode
        timestamp = (Get-Date).ToString("o")
    }

    if ($Data -ne $null) {
        $obj.data = $Data
    }
    if ($ErrorMessage) {
        $obj.error = $ErrorMessage
    }

    return ($obj | ConvertTo-Json -Depth 12)
}

function To-Array {
    param([object]$InputValue)

    if ($null -eq $InputValue) {
        return @()
    }

    if ($InputValue -is [System.Array]) {
        return @($InputValue)
    }

    if ($InputValue -is [System.Collections.IEnumerable] -and -not ($InputValue -is [string])) {
        return @($InputValue)
    }

    return @($InputValue)
}

function Invoke-WindowControl {
    param(
        [string]$ControlAction,
        [hashtable]$ArgsMap
    )

    if (-not (Test-Path $WindowControlScript)) {
        throw "Window control script not found: $WindowControlScript"
    }

    $args = @(
        "-ExecutionPolicy", "Bypass",
        "-File", $WindowControlScript,
        "-Action", $ControlAction
    )

    if ($ArgsMap) {
        foreach ($key in $ArgsMap.Keys) {
            $value = $ArgsMap[$key]
            if ($null -eq $value) {
                continue
            }
            $valueText = [string]$value
            if ([string]::IsNullOrWhiteSpace($valueText)) {
                continue
            }
            $args += @("-$key", $valueText)
        }
    }

    $raw = & powershell.exe @args
    $rawText = ($raw -join "`n")

    if ($LASTEXITCODE -ne 0 -and [string]::IsNullOrWhiteSpace($rawText)) {
        throw "codex-window-control failed with code $LASTEXITCODE"
    }

    try {
        return ($rawText | ConvertFrom-Json)
    }
    catch {
        throw "Failed to parse codex-window-control output: $rawText"
    }
}

function Ensure-Dir {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Normalize-Workdir {
    param([string]$PathText)

    if ([string]::IsNullOrWhiteSpace($PathText)) {
        return ""
    }

    try {
        return ([System.IO.Path]::GetFullPath($PathText)).TrimEnd('\\')
    }
    catch {
        return $PathText.Trim().TrimEnd('\\')
    }
}

function Resolve-LaunchWorkdir {
    param([string]$Candidate)

    $normalized = Normalize-Workdir -PathText $Candidate
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        $normalized = $DefaultWorkdir
    }

    try {
        if (-not (Test-Path -Path $normalized)) {
            $normalized = $DefaultWorkdir
        }
    }
    catch {
        $normalized = $DefaultWorkdir
    }

    return $normalized
}

function Test-IsCodexWindow {
    param([object]$Window)

    if (-not $Window) {
        return $false
    }

    $title = if ($Window.title) { [string]$Window.title } else { "" }
    $cmd = if ($Window.command_line) { [string]$Window.command_line } else { "" }
    $procName = if ($Window.process_name) { [string]$Window.process_name } else { "" }

    if ($Window.codex_likely -eq $true) {
        return $true
    }

    if ($title.ToLowerInvariant().Contains("codex") -or $title.ToLowerInvariant().Contains("gpt-5.3-codex")) {
        return $true
    }

    if ($cmd.ToLowerInvariant().Contains("codex.js") -or $cmd.ToLowerInvariant().Contains("@openai\\codex") -or $cmd.ToLowerInvariant().Contains(" codex ")) {
        return $true
    }

    if ($procName.ToLowerInvariant().Contains("codex")) {
        return $true
    }

    return $false
}

function Find-WindowInCollection {
    param(
        [object[]]$Windows,
        [Int64]$Hwnd,
        [int]$TargetPid
    )

    $all = if ($Windows) { @($Windows) } else { @() }
    if ($all.Count -eq 0) {
        return $null
    }

    if ($Hwnd -gt 0) {
        $hit = @($all | Where-Object { [Int64]$_.hwnd -eq $Hwnd })
        if ($hit.Count -gt 0) {
            return $hit[0]
        }
    }

    if ($TargetPid -gt 0) {
        $hitsByPid = @($all | Where-Object { [int]$_.pid -eq $TargetPid })
        if ($hitsByPid.Count -gt 0) {
            $codexFirst = @($hitsByPid | Where-Object { Test-IsCodexWindow -Window $_ })
            if ($codexFirst.Count -gt 0) {
                return $codexFirst[0]
            }
            return $hitsByPid[0]
        }
    }

    return $null
}

function Get-IdentityField {
    param(
        [object]$Identity,
        [string]$Name
    )

    if (-not $Identity) {
        return $null
    }

    if ($Identity.PSObject.Properties.Name -contains $Name) {
        return $Identity.$Name
    }

    return $null
}

function Get-WindowBindingByIdentity {
    param(
        [Int64]$Hwnd,
        [int]$TargetPid
    )

    if ($Hwnd -le 0 -and $TargetPid -le 0) {
        return $null
    }

    $items = Load-WindowBindings
    if (-not $items -or $items.Count -eq 0) {
        return $null
    }

    $byHwnd = @()
    if ($Hwnd -gt 0) {
        $byHwnd = @($items | Where-Object { $_.hwnd -and ([Int64]$_.hwnd -eq $Hwnd) })
    }
    if ($byHwnd.Count -gt 0) {
        return ($byHwnd | Sort-Object {
                try {
                    [DateTimeOffset]::Parse([string]$_.saved_at).UtcDateTime
                }
                catch {
                    [DateTime]::MinValue
                }
            } -Descending)[0]
    }

    if ($TargetPid -gt 0) {
        $byPid = @($items | Where-Object { $_.pid -and ([int]$_.pid -eq $TargetPid) })
        if ($byPid.Count -gt 0) {
            return ($byPid | Sort-Object {
                    try {
                        [DateTimeOffset]::Parse([string]$_.saved_at).UtcDateTime
                    }
                    catch {
                        [DateTime]::MinValue
                    }
                } -Descending)[0]
        }
    }

    return $null
}

function Find-CodexWindowByQuery {
    param(
        [object[]]$CodexWindows,
        [string]$Query
    )

    if (-not $CodexWindows -or $CodexWindows.Count -eq 0) {
        return $null
    }
    if ([string]::IsNullOrWhiteSpace($Query)) {
        return $null
    }

    $needle = $Query.Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($needle)) {
        return $null
    }

    $matched = @($CodexWindows | Where-Object {
            $title = if ($_.title) { [string]$_.title } else { "" }
            $cmd = if ($_.command_line) { [string]$_.command_line } else { "" }
            $title.ToLowerInvariant().Contains($needle) -or $cmd.ToLowerInvariant().Contains($needle)
        })

    if ($matched.Count -gt 0) {
        return $matched[0]
    }

    return $null
}

function Resolve-CodexTargetWindow {
    param(
        [object]$Identity,
        [object[]]$AllWindows,
        [object[]]$CodexWindows
    )

    $all = if ($AllWindows) { @($AllWindows) } else { @() }
    $codex = if ($CodexWindows) { @($CodexWindows) } else { @() }
    if ($all.Count -eq 0) {
        return $null
    }

    $identityHwnd = 0
    $identityPid = 0
    $identityQuery = ""
    $identitySource = ""
    if ($Identity) {
        $identityHwnd = [Int64](Get-IdentityField -Identity $Identity -Name "hwnd")
        $identityPid = [int](Get-IdentityField -Identity $Identity -Name "pid")
        $identityQuery = [string](Get-IdentityField -Identity $Identity -Name "query")
        $identitySource = [string](Get-IdentityField -Identity $Identity -Name "source")
    }

    $allowBroadFallback = $true
    if ($identitySource -eq "explicit" -and ($identityHwnd -gt 0 -or $identityPid -gt 0)) {
        $allowBroadFallback = $false
    }

    $selected = Find-WindowInCollection -Windows $all -Hwnd $identityHwnd -TargetPid $identityPid
    if ($selected -and -not (Test-IsCodexWindow -Window $selected)) {
        $samePidCodex = @($codex | Where-Object {
                $selected.pid -and $_.pid -and ([int]$_.pid -eq [int]$selected.pid)
            })
        if ($samePidCodex.Count -gt 0) {
            $selected = $samePidCodex[0]
        }
        elseif ($allowBroadFallback -and $codex.Count -gt 0) {
            $queryHit = Find-CodexWindowByQuery -CodexWindows $codex -Query $identityQuery
            if ($queryHit) {
                $selected = $queryHit
            }
            else {
                $selected = $codex[0]
            }
        }
    }

    if (-not $selected -and $allowBroadFallback) {
        $queryHit = Find-CodexWindowByQuery -CodexWindows $codex -Query $identityQuery
        if ($queryHit) {
            $selected = $queryHit
        }
    }

    if (-not $selected -and $allowBroadFallback -and $codex.Count -gt 0) {
        $selected = $codex[0]
    }

    if ($selected -and -not (Test-IsCodexWindow -Window $selected) -and $allowBroadFallback) {
        $selected = $null
    }

    return $selected
}

function Resolve-SaveWorkdir {
    param(
        [object]$Identity,
        [string]$FallbackWorkdir
    )

    $fromIdentity = Normalize-Workdir -PathText ([string](Get-IdentityField -Identity $Identity -Name "route_workdir"))
    if (-not [string]::IsNullOrWhiteSpace($fromIdentity)) {
        return $fromIdentity
    }

    return (Resolve-LaunchWorkdir -Candidate $FallbackWorkdir)
}

function Load-WindowBindings {
    if (-not (Test-Path $WindowBindingsFile)) {
        return @()
    }

    try {
        $parsed = Get-Content -Path $WindowBindingsFile -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($parsed -is [System.Array]) {
            return @($parsed)
        }
        if ($parsed) {
            return @($parsed)
        }
    }
    catch {
    }

    return @()
}

function Save-WindowBindings {
    param([object[]]$Bindings)

    Ensure-Dir -Path $StateDir
    $safe = if ($Bindings) { @($Bindings) } else { @() }
    $json = $safe | ConvertTo-Json -Depth 12
    Set-Content -Path $WindowBindingsFile -Value $json -Encoding utf8
}

function Get-WindowBindingByWorkdir {
    param([string]$WorkdirValue)

    $normalized = Normalize-Workdir -PathText $WorkdirValue
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return $null
    }

    $items = Load-WindowBindings
    if (-not $items -or $items.Count -eq 0) {
        return $null
    }

    $matched = @($items | Where-Object {
            $w = Normalize-Workdir -PathText ([string]$_.workdir)
            $w -and ($w.ToLowerInvariant() -eq $normalized.ToLowerInvariant())
        })

    if ($matched.Count -eq 0) {
        return $null
    }

    $sorted = $matched | Sort-Object {
        try {
            [DateTimeOffset]::Parse([string]$_.saved_at).UtcDateTime
        }
        catch {
            [DateTime]::MinValue
        }
    } -Descending

    return $sorted[0]
}

function Upsert-WindowBinding {
    param(
        [object]$Window,
        [string]$Query,
        [string]$WorkdirValue,
        [string]$SessionId = ""
    )

    if (-not $Window) {
        return
    }

    if (-not (Test-IsCodexWindow -Window $Window)) {
        return
    }

    $normalizedWorkdir = Normalize-Workdir -PathText $WorkdirValue
    if ([string]::IsNullOrWhiteSpace($normalizedWorkdir)) {
        return
    }

    $bindings = Load-WindowBindings
    $filtered = @($bindings | Where-Object {
            $sameHwnd = ($_.hwnd -and ([Int64]$_.hwnd -eq [Int64]$Window.hwnd))
            $sameWorkdir = (Normalize-Workdir -PathText ([string]$_.workdir)).ToLowerInvariant() -eq $normalizedWorkdir.ToLowerInvariant()
            -not ($sameHwnd -or $sameWorkdir)
        })

    $entry = [ordered]@{
        saved_at = (Get-Date).ToUniversalTime().ToString("o")
        workdir = $normalizedWorkdir
        query = $Query
        hwnd = [Int64]$Window.hwnd
        pid = [int]$Window.pid
        title = [string]$Window.title
        session_id = if ([string]::IsNullOrWhiteSpace($SessionId)) { $null } else { $SessionId }
    }

    $next = @($entry) + $filtered
    if ($next.Count -gt 30) {
        $next = $next[0..29]
    }
    Save-WindowBindings -Bindings $next
}

function Save-ActiveWindow {
    param(
        [object]$Window,
        [string]$Query,
        [string]$WorkdirValue,
        [string]$SessionId = ""
    )

    if (-not $Window) {
        return
    }

    if (-not (Test-IsCodexWindow -Window $Window)) {
        return
    }

    Ensure-Dir -Path $StateDir
    $obj = [ordered]@{
        saved_at = (Get-Date).ToUniversalTime().ToString("o")
        query = $Query
        hwnd = [Int64]$Window.hwnd
        pid = [int]$Window.pid
        title = [string]$Window.title
        workdir = $WorkdirValue
        session_id = if ([string]::IsNullOrWhiteSpace($SessionId)) { $null } else { $SessionId }
    }
    $json = $obj | ConvertTo-Json -Depth 10
    Set-Content -Path $ActiveWindowFile -Value $json -Encoding utf8

    Upsert-WindowBinding -Window $Window -Query $Query -WorkdirValue $WorkdirValue -SessionId $SessionId
}

function Load-ActiveWindow {
    if (-not (Test-Path $ActiveWindowFile)) {
        return $null
    }
    try {
        return (Get-Content -Path $ActiveWindowFile -Raw -ErrorAction Stop | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Resolve-TargetIdentity {
    param(
        [Int64]$InputHwnd,
        [int]$InputPid,
        [string]$InputQuery,
        [string]$InputRouteWorkdir
    )

    if ($InputHwnd -gt 0 -or $InputPid -gt 0) {
        return [pscustomobject]@{
            hwnd = $InputHwnd
            pid = $InputPid
            query = $InputQuery
            source = "explicit"
        }
    }

    $routeWorkdirNormalized = Normalize-Workdir -PathText $InputRouteWorkdir
    if (-not [string]::IsNullOrWhiteSpace($routeWorkdirNormalized)) {
        $binding = Get-WindowBindingByWorkdir -WorkdirValue $routeWorkdirNormalized
        if ($binding) {
            return [pscustomobject]@{
                hwnd = if ($binding.hwnd) { [Int64]$binding.hwnd } else { 0 }
                pid = if ($binding.pid) { [int]$binding.pid } else { 0 }
                query = if ([string]::IsNullOrWhiteSpace($InputQuery)) { [string]$binding.query } else { $InputQuery }
                source = "workdir_saved"
                route_workdir = $routeWorkdirNormalized
                binding = $binding
            }
        }

        return [pscustomobject]@{
            hwnd = 0
            pid = 0
            query = $InputQuery
            source = "workdir_missing"
            route_workdir = $routeWorkdirNormalized
        }
    }

    $saved = Load-ActiveWindow
    if ($saved) {
        return [pscustomobject]@{
            hwnd = if ($saved.hwnd) { [Int64]$saved.hwnd } else { 0 }
            pid = if ($saved.pid) { [int]$saved.pid } else { 0 }
            query = if ([string]::IsNullOrWhiteSpace($InputQuery)) { [string]$saved.query } else { $InputQuery }
            source = "saved"
            saved = $saved
        }
    }

    return [pscustomobject]@{
        hwnd = 0
        pid = 0
        query = $InputQuery
        source = "query"
    }
}

function Try-ParseUtc {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }

    try {
        return ([DateTimeOffset]::Parse($Text).ToUniversalTime())
    }
    catch {
        return $null
    }
}

function Get-CodexWindows {
    param([object]$ListResponse)

    if (-not $ListResponse -or -not $ListResponse.data -or -not $ListResponse.data.windows) {
        return @()
    }

    $all = @($ListResponse.data.windows)

    $result = @()
    foreach ($w in $all) {
        $title = if ($w.title) { [string]$w.title } else { "" }
        $cmd = if ($w.command_line) { [string]$w.command_line } else { "" }
        $processName = if ($w.process_name) { [string]$w.process_name } else { "" }
        $looksCodexByTitle = ($title.ToLowerInvariant().Contains("codex") -or $title.ToLowerInvariant().Contains("gpt-5.3-codex"))
        $looksCodexByCmd = ($cmd.ToLowerInvariant().Contains("codex") -or $cmd.ToLowerInvariant().Contains("codex.js") -or $cmd.ToLowerInvariant().Contains("@openai\\codex"))
        $looksCodexByFlag = ($w.codex_likely -eq $true)

        if ($looksCodexByTitle -or $looksCodexByCmd -or $looksCodexByFlag -or $processName.ToLowerInvariant().Contains("codex")) {
            $result += $w
        }
    }

    return (To-Array -InputValue $result)
}

function Read-LatestForRequest {
    param(
        [string]$RequestSinceUtc,
        [string]$SessionIdValue,
        [Int64]$TargetHwnd,
        [int]$TargetPid,
        [string]$BridgeWorkdir,
        [int]$Tail,
        [int]$MaxTries,
        [int]$IntervalMs,
        [int]$HardTimeoutSeconds,
        [bool]$NeedFinal
    )

    $normalizedSessionId = if ([string]::IsNullOrWhiteSpace($SessionIdValue)) { "" } else { $SessionIdValue.Trim().ToLowerInvariant() }

    $sinceUtc = Try-ParseUtc -Text $RequestSinceUtc
    $latest = $null
    $lastResponse = $null
    $usedTry = 0
    $stableCount = 0
    $lastSeenKey = ""
    $firstHitAt = $null
    $quietSecondsRequired = if ($NeedFinal) { [Math]::Max(8, [int][Math]::Ceiling(($IntervalMs * 3) / 1000.0)) } else { 0 }
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $HardTimeoutSeconds))

    $useStrictSession = -not [string]::IsNullOrWhiteSpace($normalizedSessionId)
    $strictNoHitCount = 0
    $strictMismatchCount = 0

    for ($i = 1; $i -le $MaxTries; $i++) {
        $usedTry = $i

        $params = @{
            TailLines = $Tail
            UseLastRequest = "false"
            WindowHwnd = if ($TargetHwnd -gt 0) { "$TargetHwnd" } else { $null }
            WindowPid = if ($TargetPid -gt 0) { "$TargetPid" } else { $null }
        }
        if (-not [string]::IsNullOrWhiteSpace($RequestSinceUtc)) {
            $params.SinceIso = $RequestSinceUtc
        }
        if (-not [string]::IsNullOrWhiteSpace($BridgeWorkdir)) {
            $params.Workdir = $BridgeWorkdir
        }
        if ($useStrictSession) {
            $params.SessionId = $normalizedSessionId
        }

        $res = Invoke-WindowControl -ControlAction "latest_output" -ArgsMap $params
        if ($res) {
            $lastResponse = $res
        }
        $bridge = $null
        if ($res -and $res.data -and $res.data.bridge) {
            $bridge = $res.data.bridge
        }

        $hasAssistant = ($bridge -and $bridge.ok -and -not [string]::IsNullOrWhiteSpace([string]$bridge.latest_assistant))

        if ($useStrictSession) {
            if ($hasAssistant) {
                $bridgeSessionId = ""
                if ($bridge.session_id) {
                    $bridgeSessionId = ([string]$bridge.session_id).Trim().ToLowerInvariant()
                }
                if ($bridgeSessionId -ne $normalizedSessionId) {
                    $strictMismatchCount += 1
                    $hasAssistant = $false
                }
            }
            else {
                $strictNoHitCount += 1
            }

            if (($strictNoHitCount -ge 2) -or ($strictMismatchCount -ge 2)) {
                $useStrictSession = $false
                $stableCount = 0
                $lastSeenKey = ""
                $firstHitAt = $null
            }
        }

        if ($hasAssistant) {
            $bridgeTs = Try-ParseUtc -Text ([string]$bridge.latest_assistant_timestamp)
            if (-not $sinceUtc -or (-not $bridgeTs) -or $bridgeTs -gt $sinceUtc) {
                $latest = $res

                $currentKey = "{0}|{1}" -f ([string]$bridge.latest_assistant_timestamp), ([string]$bridge.latest_assistant)
                if ($currentKey -eq $lastSeenKey) {
                    $stableCount += 1
                }
                else {
                    $lastSeenKey = $currentKey
                    $stableCount = 1
                    $firstHitAt = Get-Date
                }

                if (-not $NeedFinal) {
                    break
                }

                $quietEnough = $false
                if ($firstHitAt) {
                    $elapsedSec = ((Get-Date) - $firstHitAt).TotalSeconds
                    if ($elapsedSec -ge $quietSecondsRequired) {
                        $quietEnough = $true
                    }
                }

                $looksFinal = $false
                $assistantTextLower = ([string]$bridge.latest_assistant).ToLowerInvariant()
                if (
                    $assistantTextLower.Contains("任务完成") -or
                    $assistantTextLower.Contains("已完成") -or
                    $assistantTextLower.Contains("完成") -or
                    $assistantTextLower.Contains("done") -or
                    $assistantTextLower.Contains("finished")
                ) {
                    $looksFinal = $true
                }

                if (($quietEnough -and $stableCount -ge 2) -or ($stableCount -ge 2 -and $looksFinal)) {
                    break
                }

                if ((Get-Date) -ge $deadline) {
                    break
                }
            }
        }

        if ((Get-Date) -ge $deadline) {
            break
        }

        Start-Sleep -Milliseconds $IntervalMs
    }

    return [pscustomobject]@{
        latest_response = $latest
        last_response = $lastResponse
        poll_tries = $usedTry
        strict_session_initial = (-not [string]::IsNullOrWhiteSpace($normalizedSessionId))
        strict_session_final = $useStrictSession
    }
}

function Resolve-CaptureTimestampUtc {
    param([object]$CaptureResponse)

    if (-not $CaptureResponse -or -not $CaptureResponse.data -or -not $CaptureResponse.data.screenshot) {
        return $null
    }

    $shot = $CaptureResponse.data.screenshot

    foreach ($field in @("captured_at_utc", "captured_at", "timestamp_utc", "timestamp")) {
        if ($shot.PSObject -and $shot.PSObject.Properties.Name -contains $field) {
            $raw = [string]$shot.$field
            $parsed = Try-ParseUtc -Text $raw
            if ($parsed) {
                return $parsed.ToString("o")
            }
        }
    }

    $fileName = if ($shot.file_name) { [string]$shot.file_name } else { "" }
    if ($fileName -match "window-(\d{8}-\d{6})-") {
        $stamp = $Matches[1]
        try {
            $localDt = [DateTime]::ParseExact($stamp, "yyyyMMdd-HHmmss", [System.Globalization.CultureInfo]::InvariantCulture)
            $asLocal = [DateTime]::SpecifyKind($localDt, [DateTimeKind]::Local)
            return ([DateTimeOffset]$asLocal).ToUniversalTime().ToString("o")
        }
        catch {
        }
    }

    return (Get-Date).ToUniversalTime().ToString("o")
}

function Get-FreshnessDecision {
    param(
        [object]$Bridge,
        [string]$CaptureTimestampUtc,
        [int]$MaxAgeSeconds = 60
    )

    $nowUtc = (Get-Date).ToUniversalTime()
    $nodeConnected = $false
    $dataFresh = $false
    $ageSeconds = $null
    $failureReason = $null

    $captureTs = Try-ParseUtc -Text $CaptureTimestampUtc

    if (-not $Bridge) {
        $failureReason = "bridge_missing"
        return [pscustomobject]@{
            node_connected = $nodeConnected
            data_fresh = $dataFresh
            freshness_age_seconds = $ageSeconds
            capture_timestamp_utc = if ($captureTs) { $captureTs.ToString("o") } else { $null }
            failure_reason = $failureReason
        }
    }

    $bridgeErrorText = ""
    if ($Bridge.error) {
        $bridgeErrorText = ([string]$Bridge.error).Trim().ToLowerInvariant()
    }

    $bridgeHardUnavailable = $false
    if (
        $bridgeErrorText.Contains("codex command not found") -or
        $bridgeErrorText.Contains("window control script not found") -or
        $bridgeErrorText.Contains("failed to parse")
    ) {
        $bridgeHardUnavailable = $true
    }

    if ($bridgeHardUnavailable) {
        $failureReason = "bridge_unavailable"
        return [pscustomobject]@{
            node_connected = $nodeConnected
            data_fresh = $dataFresh
            freshness_age_seconds = $ageSeconds
            capture_timestamp_utc = if ($captureTs) { $captureTs.ToString("o") } else { $null }
            failure_reason = $failureReason
        }
    }

    $nodeConnected = $true

    $assistantText = if ($Bridge.latest_assistant) { [string]$Bridge.latest_assistant } else { "" }
    if ([string]::IsNullOrWhiteSpace($assistantText)) {
        if ($bridgeErrorText.Contains("no codex session file found")) {
            $failureReason = "session_missing"
        }
        elseif ($bridgeErrorText.Contains("no assistant output found")) {
            $failureReason = "assistant_missing"
        }
        else {
            $failureReason = "assistant_missing"
        }
        return [pscustomobject]@{
            node_connected = $nodeConnected
            data_fresh = $dataFresh
            freshness_age_seconds = $ageSeconds
            capture_timestamp_utc = if ($captureTs) { $captureTs.ToString("o") } else { $null }
            failure_reason = $failureReason
        }
    }

    $assistantTs = Try-ParseUtc -Text ([string]$Bridge.latest_assistant_timestamp)
    if (-not $assistantTs) {
        $failureReason = "assistant_timestamp_missing"
        return [pscustomobject]@{
            node_connected = $nodeConnected
            data_fresh = $dataFresh
            freshness_age_seconds = $ageSeconds
            capture_timestamp_utc = if ($captureTs) { $captureTs.ToString("o") } else { $null }
            failure_reason = $failureReason
        }
    }

    $ageRaw = ($nowUtc - $assistantTs.UtcDateTime).TotalSeconds
    if ($ageRaw -lt 0) {
        $ageRaw = 0
    }
    $ageSeconds = [int][Math]::Floor($ageRaw)

    if ($ageSeconds -gt [Math]::Max(1, $MaxAgeSeconds)) {
        $failureReason = "assistant_stale"
        return [pscustomobject]@{
            node_connected = $nodeConnected
            data_fresh = $dataFresh
            freshness_age_seconds = $ageSeconds
            capture_timestamp_utc = if ($captureTs) { $captureTs.ToString("o") } else { $null }
            failure_reason = $failureReason
        }
    }

    if ($captureTs) {
        $captureAgeRaw = ($nowUtc - $captureTs.UtcDateTime).TotalSeconds
        if ($captureAgeRaw -lt 0) {
            $captureAgeRaw = 0
        }
        $captureAgeSeconds = [int][Math]::Floor($captureAgeRaw)
        if ($captureAgeSeconds -gt [Math]::Max(1, $MaxAgeSeconds)) {
            $failureReason = "screenshot_stale"
            return [pscustomobject]@{
                node_connected = $nodeConnected
                data_fresh = $dataFresh
                freshness_age_seconds = $ageSeconds
                capture_timestamp_utc = $captureTs.ToString("o")
                failure_reason = $failureReason
            }
        }
    }

    $dataFresh = $true
    return [pscustomobject]@{
        node_connected = $nodeConnected
        data_fresh = $dataFresh
        freshness_age_seconds = $ageSeconds
        capture_timestamp_utc = if ($captureTs) { $captureTs.ToString("o") } else { $null }
        failure_reason = $null
    }
}

try {
    $requireCompletionBool = $true
    if (-not [string]::IsNullOrWhiteSpace($RequireCompletion)) {
        $v = $RequireCompletion.Trim().ToLowerInvariant()
        if ($v -in @("0", "false", "no", "off")) {
            $requireCompletionBool = $false
        }
    }

    switch ($Action) {
        "peek" {
            $listRes = Invoke-WindowControl -ControlAction "list_windows" -ArgsMap @{}
            $codexWins = To-Array -InputValue (Get-CodexWindows -ListResponse $listRes)

            $targetIdentity = Resolve-TargetIdentity -InputHwnd $WindowHwnd -InputPid $WindowPid -InputQuery $WindowQuery -InputRouteWorkdir $RouteWorkdir

            $allWins = @()
            if ($listRes -and $listRes.data -and $listRes.data.windows) {
                $allWins = @($listRes.data.windows)
            }

            if ($targetIdentity.source -eq "saved" -and $codexWins.Count -eq 0) {
                $savedHwnd = [Int64](Get-IdentityField -Identity $targetIdentity -Name "hwnd")
                $savedPid = [int](Get-IdentityField -Identity $targetIdentity -Name "pid")
                if ($savedHwnd -gt 0 -or $savedPid -gt 0) {
                    $savedInAll = Find-WindowInCollection -Windows $allWins -Hwnd $savedHwnd -TargetPid $savedPid
                    if ($savedInAll) {
                        $codexWins = @($savedInAll)
                    }
                }
            }

            $resolvedWin = Resolve-CodexTargetWindow -Identity $targetIdentity -AllWindows $allWins -CodexWindows $codexWins
            if ($resolvedWin) {
                $targetIdentity = [pscustomobject]@{
                    hwnd = [Int64]$resolvedWin.hwnd
                    pid = [int]$resolvedWin.pid
                    query = if ([string]::IsNullOrWhiteSpace([string]$targetIdentity.query)) { $WindowQuery } else { $targetIdentity.query }
                    source = if ($targetIdentity.source -eq "workdir_missing") { "query_fallback" } else { $targetIdentity.source }
                    route_workdir = Get-IdentityField -Identity $targetIdentity -Name "route_workdir"
                }
            }

            $latestArgs = @{
                TailLines = $TailLines
                UseLastRequest = "false"
            }

            $bindFromIdentity = Get-WindowBindingByIdentity -Hwnd ([Int64]$targetIdentity.hwnd) -TargetPid ([int]$targetIdentity.pid)
            $peekBridgeWorkdir = Resolve-SaveWorkdir -Identity $targetIdentity -FallbackWorkdir $Workdir
            if ($bindFromIdentity -and $bindFromIdentity.session_id) {
                $latestArgs.SessionId = [string]$bindFromIdentity.session_id
            }
            if (-not [string]::IsNullOrWhiteSpace($peekBridgeWorkdir)) {
                $latestArgs.Workdir = $peekBridgeWorkdir
            }

            if ($targetIdentity.hwnd -gt 0) {
                $latestArgs.WindowHwnd = "$($targetIdentity.hwnd)"
            }
            if ($targetIdentity.pid -gt 0) {
                $latestArgs.WindowPid = "$($targetIdentity.pid)"
            }

            $captureArgs = @{
                WindowQuery = $targetIdentity.query
                WindowPadding = $WindowPadding
                FocusBeforeCapture = "true"
            }
            if ($targetIdentity.hwnd -gt 0) {
                $captureArgs.WindowHwnd = "$($targetIdentity.hwnd)"
            }
            if ($targetIdentity.pid -gt 0) {
                $captureArgs.WindowPid = "$($targetIdentity.pid)"
            }

            $latestRes = Invoke-WindowControl -ControlAction "latest_output" -ArgsMap $latestArgs

            $captureRes = Invoke-WindowControl -ControlAction "capture_window" -ArgsMap $captureArgs

            if ($captureRes -and $captureRes.data -and $captureRes.data.target) {
                $saveWorkdir = Resolve-SaveWorkdir -Identity $targetIdentity -FallbackWorkdir $Workdir
                $saveSessionId = if ($latestRes -and $latestRes.data -and $latestRes.data.bridge -and $latestRes.data.bridge.session_id) { [string]$latestRes.data.bridge.session_id } else { "" }
                Save-ActiveWindow -Window $captureRes.data.target -Query $targetIdentity.query -WorkdirValue $saveWorkdir -SessionId $saveSessionId
            }

            $bridge = $null
            if ($latestRes -and $latestRes.data -and $latestRes.data.bridge) {
                $bridge = $latestRes.data.bridge
            }

            $captureTimestampUtc = Resolve-CaptureTimestampUtc -CaptureResponse $captureRes
            $freshness = Get-FreshnessDecision -Bridge $bridge -CaptureTimestampUtc $captureTimestampUtc -MaxAgeSeconds $FreshnessMaxAgeSeconds
            $codexWinsArray = To-Array -InputValue $codexWins
            if (@($codexWinsArray).Length -eq 0 -and $resolvedWin) {
                $codexWinsArray = @($resolvedWin)
            }

            $latestAssistant = if ($bridge) { $bridge.latest_assistant } else { $null }
            $latestAssistantTs = if ($bridge) { $bridge.latest_assistant_timestamp } else { $null }
            $screenshotUrl = if ($captureRes -and $captureRes.data -and $captureRes.data.screenshot) { $captureRes.data.screenshot.url } else { $null }
            $screenshotObj = if ($captureRes -and $captureRes.data) { $captureRes.data.screenshot } else { $null }
            $targetWindow = if ($captureRes -and $captureRes.data) { $captureRes.data.target } else { $null }

            if (-not $freshness.data_fresh) {
                $latestAssistant = $null
                $latestAssistantTs = $null
                $screenshotUrl = $null
                $screenshotObj = $null
                $targetWindow = $null
            }

            $data = [pscustomobject]@{
                codex_windows_count = [int](@($codexWinsArray).Length)
                codex_windows = @($codexWinsArray)
                latest_assistant = $latestAssistant
                latest_assistant_timestamp = $latestAssistantTs
                screenshot_url = $screenshotUrl
                screenshot = $screenshotObj
                target_window = $targetWindow
                target_source = $targetIdentity.source
                route_workdir = if ([string]::IsNullOrWhiteSpace($RouteWorkdir)) { $null } else { (Normalize-Workdir -PathText $RouteWorkdir) }
                node_connected = [bool]$freshness.node_connected
                data_fresh = [bool]$freshness.data_fresh
                freshness_age_seconds = if ($null -eq $freshness.freshness_age_seconds) { $null } else { [int]$freshness.freshness_age_seconds }
                capture_timestamp_utc = $freshness.capture_timestamp_utc
                failure_reason = $freshness.failure_reason
            }

            $peekOk = [bool]$freshness.data_fresh
            $peekErr = if ($peekOk) { $null } else { "Codex state is unavailable: $($freshness.failure_reason)" }
            $peekCode = if ($peekOk) { 0 } else { 4 }
            Write-Output (New-Result -Ok $peekOk -ActionName $Action -Data $data -ErrorMessage $peekErr -ExitCode $peekCode)
            if ($peekOk) { exit 0 } else { exit 4 }
        }

        "ask" {
            if ([string]::IsNullOrWhiteSpace($Text)) {
                Write-Output (New-Result -Ok $false -ActionName $Action -Data $null -ErrorMessage "Text is required for ask" -ExitCode 2)
                exit 2
            }

            $targetIdentity = Resolve-TargetIdentity -InputHwnd $WindowHwnd -InputPid $WindowPid -InputQuery $WindowQuery -InputRouteWorkdir $RouteWorkdir

            $autoOpenResult = $null
            if ($targetIdentity.source -eq "workdir_missing") {
                $autoWorkdirCandidate = if (-not [string]::IsNullOrWhiteSpace($targetIdentity.route_workdir)) { [string]$targetIdentity.route_workdir } else { (Normalize-Workdir -PathText $Workdir) }
                $autoWorkdir = Resolve-LaunchWorkdir -Candidate $autoWorkdirCandidate

                $autoOpenRes = Invoke-WindowControl -ControlAction "open_codex" -ArgsMap @{
                    Workdir = $autoWorkdir
                    Model = "gpt-5.3-codex"
                    UseYolo = "true"
                }
                if ($autoOpenRes -and $autoOpenRes.data) {
                    $autoOpenResult = $autoOpenRes.data
                    $openedWindow = $autoOpenRes.data.focused_window
                    if ($openedWindow) {
                        Save-ActiveWindow -Window $openedWindow -Query $WindowQuery -WorkdirValue $autoWorkdir -SessionId ""
                        $targetIdentity = [pscustomobject]@{
                            hwnd = [Int64]$openedWindow.hwnd
                            pid = [int]$openedWindow.pid
                            query = $WindowQuery
                            source = "auto_open_by_workdir"
                            route_workdir = $autoWorkdir
                        }
                    }
                }
            }

            $listBeforeSend = Invoke-WindowControl -ControlAction "list_windows" -ArgsMap @{}
            $allBeforeSend = if ($listBeforeSend -and $listBeforeSend.data -and $listBeforeSend.data.windows) { @($listBeforeSend.data.windows) } else { @() }
            $codexBeforeSend = To-Array -InputValue (Get-CodexWindows -ListResponse $listBeforeSend)
            $resolvedBeforeSend = Resolve-CodexTargetWindow -Identity $targetIdentity -AllWindows $allBeforeSend -CodexWindows $codexBeforeSend
            if ($resolvedBeforeSend) {
                $targetIdentity = [pscustomobject]@{
                    hwnd = [Int64]$resolvedBeforeSend.hwnd
                    pid = [int]$resolvedBeforeSend.pid
                    query = if ([string]::IsNullOrWhiteSpace([string]$targetIdentity.query)) { $WindowQuery } else { $targetIdentity.query }
                    source = $targetIdentity.source
                    route_workdir = Get-IdentityField -Identity $targetIdentity -Name "route_workdir"
                }
            }
            elseif ($codexBeforeSend.Count -eq 0) {
                $autoWorkdirCandidate2 = if (-not [string]::IsNullOrWhiteSpace($targetIdentity.route_workdir)) { [string]$targetIdentity.route_workdir } else { (Normalize-Workdir -PathText $Workdir) }
                $autoWorkdir2 = Resolve-LaunchWorkdir -Candidate $autoWorkdirCandidate2

                $autoOpenRes2 = Invoke-WindowControl -ControlAction "open_codex" -ArgsMap @{
                    Workdir = $autoWorkdir2
                    Model = "gpt-5.3-codex"
                    UseYolo = "true"
                }

                if ($autoOpenRes2 -and $autoOpenRes2.data) {
                    if (-not $autoOpenResult) {
                        $autoOpenResult = $autoOpenRes2.data
                    }
                    $openedWindow2 = $autoOpenRes2.data.focused_window
                    if ($openedWindow2 -and (Test-IsCodexWindow -Window $openedWindow2)) {
                        Save-ActiveWindow -Window $openedWindow2 -Query $WindowQuery -WorkdirValue $autoWorkdir2 -SessionId ""
                        $targetIdentity = [pscustomobject]@{
                            hwnd = [Int64]$openedWindow2.hwnd
                            pid = [int]$openedWindow2.pid
                            query = $WindowQuery
                            source = "auto_open_by_workdir"
                            route_workdir = $autoWorkdir2
                        }
                    }
                }
            }

            $bindWorkdir = Resolve-SaveWorkdir -Identity $targetIdentity -FallbackWorkdir $Workdir

            $bindingForSend = Get-WindowBindingByIdentity -Hwnd ([Int64]$targetIdentity.hwnd) -TargetPid ([int]$targetIdentity.pid)

            $sendRes = Invoke-WindowControl -ControlAction "send_text" -ArgsMap @{
                Workdir = $bindWorkdir
                WindowQuery = $targetIdentity.query
                WindowHwnd = if ($targetIdentity.hwnd -gt 0) { "$($targetIdentity.hwnd)" } else { $null }
                WindowPid = if ($targetIdentity.pid -gt 0) { "$($targetIdentity.pid)" } else { $null }
                Text = $Text
                PressEnter = "true"
                TailLines = $TailLines
                SessionId = if ($bindingForSend -and $bindingForSend.session_id) { [string]$bindingForSend.session_id } else { $null }
            }

            $tracker = $null
            if ($sendRes -and $sendRes.data -and $sendRes.data.tracker) {
                $tracker = $sendRes.data.tracker
            }

            $requestSince = if ($tracker) { [string]$tracker.request_time_utc } else { $null }
            $sessionIdValue = if ($tracker) { [string]$tracker.session_id } else { $null }
            if ([string]::IsNullOrWhiteSpace($sessionIdValue) -and $bindingForSend -and $bindingForSend.session_id) {
                $sessionIdValue = [string]$bindingForSend.session_id
            }

            $pollBridgeWorkdir = Resolve-SaveWorkdir -Identity $targetIdentity -FallbackWorkdir $Workdir

            $targetHwnd = 0
            $targetPid = 0
            if ($tracker) {
                if ($tracker.target_hwnd) {
                    $targetHwnd = [Int64]$tracker.target_hwnd
                }
                if ($tracker.target_pid) {
                    $targetPid = [int]$tracker.target_pid
                }
            }
            if ($targetHwnd -le 0 -and $targetIdentity.hwnd -gt 0) {
                $targetHwnd = [Int64]$targetIdentity.hwnd
            }
            if ($targetPid -le 0 -and $targetIdentity.pid -gt 0) {
                $targetPid = [int]$targetIdentity.pid
            }

            $listAfterSend = Invoke-WindowControl -ControlAction "list_windows" -ArgsMap @{}
            $allAfterSend = if ($listAfterSend -and $listAfterSend.data -and $listAfterSend.data.windows) { @($listAfterSend.data.windows) } else { @() }
            $codexAfterSend = To-Array -InputValue (Get-CodexWindows -ListResponse $listAfterSend)
            $targetFromTracker = Find-WindowInCollection -Windows $allAfterSend -Hwnd $targetHwnd -TargetPid $targetPid
            if ($targetFromTracker -and -not (Test-IsCodexWindow -Window $targetFromTracker)) {
                $codexByPid = @($codexAfterSend | Where-Object { $targetFromTracker.pid -and $_.pid -and ([int]$_.pid -eq [int]$targetFromTracker.pid) })
                if ($codexByPid.Count -gt 0) {
                    $targetFromTracker = $codexByPid[0]
                }
            }
            if (-not $targetFromTracker) {
                $targetFromTracker = Resolve-CodexTargetWindow -Identity $targetIdentity -AllWindows $allAfterSend -CodexWindows $codexAfterSend
            }
            if ($targetFromTracker) {
                $targetHwnd = [Int64]$targetFromTracker.hwnd
                $targetPid = [int]$targetFromTracker.pid
            }

            $minTriesByTimeout = [int][Math]::Ceiling(([Math]::Max(5, $MaxWaitSeconds) * 1000.0) / [Math]::Max(200, $PollIntervalMs))
            $effectivePollMaxTries = [Math]::Max($PollMaxTries, $minTriesByTimeout)
            $poll = Read-LatestForRequest -RequestSinceUtc $requestSince -SessionIdValue $sessionIdValue -TargetHwnd $targetHwnd -TargetPid $targetPid -BridgeWorkdir $pollBridgeWorkdir -Tail $TailLines -MaxTries $effectivePollMaxTries -IntervalMs $PollIntervalMs -HardTimeoutSeconds $MaxWaitSeconds -NeedFinal $requireCompletionBool
            $latestRes = $poll.latest_response

            if (-not $latestRes -and $poll.last_response) {
                $latestRes = $poll.last_response
            }

            if (-not $latestRes) {
                $fallbackParams = @{
                    TailLines = $TailLines
                    UseLastRequest = "false"
                    WindowHwnd = if ($targetHwnd -gt 0) { "$targetHwnd" } else { $null }
                    WindowPid = if ($targetPid -gt 0) { "$targetPid" } else { $null }
                    SinceIso = if ([string]::IsNullOrWhiteSpace($requestSince)) { $null } else { $requestSince }
                    Workdir = if ([string]::IsNullOrWhiteSpace($pollBridgeWorkdir)) { $null } else { $pollBridgeWorkdir }
                    SessionId = if ([string]::IsNullOrWhiteSpace($sessionIdValue)) { $null } else { $sessionIdValue }
                }
                try {
                    $latestRes = Invoke-WindowControl -ControlAction "latest_output" -ArgsMap $fallbackParams
                }
                catch {
                }
            }

            $captureArgs = @{
                WindowQuery = if ($tracker -and $tracker.window_query) { [string]$tracker.window_query } else { $targetIdentity.query }
                WindowPadding = $WindowPadding
                FocusBeforeCapture = "true"
                WindowHwnd = if ($targetHwnd -gt 0) { "$targetHwnd" } else { $null }
                WindowPid = if ($targetPid -gt 0) { "$targetPid" } else { $null }
            }
            $captureRes = Invoke-WindowControl -ControlAction "capture_window" -ArgsMap $captureArgs

            if ($captureRes -and $captureRes.data -and $captureRes.data.target) {
                $saveWorkdir = Resolve-SaveWorkdir -Identity $targetIdentity -FallbackWorkdir $Workdir
                $saveSessionId = if ($sessionIdValue) { $sessionIdValue } else { "" }
                if ([string]::IsNullOrWhiteSpace($saveSessionId) -and $latestRes -and $latestRes.data -and $latestRes.data.bridge -and $latestRes.data.bridge.session_id) {
                    $saveSessionId = [string]$latestRes.data.bridge.session_id
                }
                Save-ActiveWindow -Window $captureRes.data.target -Query $captureArgs.WindowQuery -WorkdirValue $saveWorkdir -SessionId $saveSessionId
            }

            $bridge = $null
            if ($latestRes -and $latestRes.data -and $latestRes.data.bridge) {
                $bridge = $latestRes.data.bridge
            }

            $captureTimestampUtc = Resolve-CaptureTimestampUtc -CaptureResponse $captureRes
            $freshness = Get-FreshnessDecision -Bridge $bridge -CaptureTimestampUtc $captureTimestampUtc -MaxAgeSeconds $FreshnessMaxAgeSeconds

            $latestAssistant = if ($bridge) { $bridge.latest_assistant } else { $null }
            $latestAssistantTs = if ($bridge) { $bridge.latest_assistant_timestamp } else { $null }
            $screenshotUrl = if ($captureRes -and $captureRes.data -and $captureRes.data.screenshot) { $captureRes.data.screenshot.url } else { $null }
            $screenshotObj = if ($captureRes -and $captureRes.data) { $captureRes.data.screenshot } else { $null }
            $targetWindow = if ($captureRes -and $captureRes.data) { $captureRes.data.target } else { $null }

            if (-not $freshness.data_fresh) {
                $latestAssistant = $null
                $latestAssistantTs = $null
                $screenshotUrl = $null
                $screenshotObj = $null
                $targetWindow = $null
            }

            $data = [pscustomobject]@{
                sent_text = $Text
                tracker = $tracker
                poll_tries = $poll.poll_tries
                poll_max_tries_effective = $effectivePollMaxTries
                max_wait_seconds = $MaxWaitSeconds
                require_completion = $requireCompletionBool
                strict_session_initial = $poll.strict_session_initial
                strict_session_final = $poll.strict_session_final
                latest_assistant = $latestAssistant
                latest_assistant_timestamp = $latestAssistantTs
                screenshot_url = $screenshotUrl
                screenshot = $screenshotObj
                target_window = $targetWindow
                target_source = $targetIdentity.source
                route_workdir = if ([string]::IsNullOrWhiteSpace($RouteWorkdir)) { $null } else { (Normalize-Workdir -PathText $RouteWorkdir) }
                auto_open_result = $autoOpenResult
                node_connected = [bool]$freshness.node_connected
                data_fresh = [bool]$freshness.data_fresh
                freshness_age_seconds = if ($null -eq $freshness.freshness_age_seconds) { $null } else { [int]$freshness.freshness_age_seconds }
                capture_timestamp_utc = $freshness.capture_timestamp_utc
                failure_reason = $freshness.failure_reason
            }

            $ok = [bool]$freshness.data_fresh
            $err = if ($ok) { $null } else { "No fresh assistant output matched this request: $($freshness.failure_reason)" }
            $code = if ($ok) { 0 } else { 3 }
            Write-Output (New-Result -Ok $ok -ActionName $Action -Data $data -ErrorMessage $err -ExitCode $code)
            if ($ok) { exit 0 } else { exit 3 }
        }

        "new" {
            $newWorkdir = Resolve-LaunchWorkdir -Candidate $Workdir

            $openRes = Invoke-WindowControl -ControlAction "open_codex" -ArgsMap @{
                Workdir = $newWorkdir
                Model = "gpt-5.3-codex"
                UseYolo = "true"
            }

            $opened = $null
            if ($openRes -and $openRes.data -and $openRes.data.focused_window) {
                $opened = $openRes.data.focused_window
                Save-ActiveWindow -Window $opened -Query $WindowQuery -WorkdirValue $newWorkdir
            }

            $captureRes = Invoke-WindowControl -ControlAction "capture_window" -ArgsMap @{
                WindowQuery = if ($opened -and $opened.title) { [string]$opened.title } else { $WindowQuery }
                WindowHwnd = if ($opened -and $opened.hwnd) { "$( [Int64]$opened.hwnd )" } else { $null }
                WindowPid = if ($opened -and $opened.pid) { "$( [int]$opened.pid )" } else { $null }
                WindowPadding = $WindowPadding
                FocusBeforeCapture = "true"
            }

            $data = [pscustomobject]@{
                workdir = $newWorkdir
                open_result = $openRes.data
                target_window = $opened
                screenshot_url = if ($captureRes -and $captureRes.data -and $captureRes.data.screenshot) { $captureRes.data.screenshot.url } else { $null }
                screenshot = if ($captureRes -and $captureRes.data) { $captureRes.data.screenshot } else { $null }
            }

            Write-Output (New-Result -Ok $true -ActionName $Action -Data $data -ErrorMessage $null)
            exit 0
        }
    }
}
catch {
    $detail = $_.Exception.Message
    if ($_.ScriptStackTrace) {
        $detail = "$detail`n$($_.ScriptStackTrace)"
    }
    Write-Output (New-Result -Ok $false -ActionName $Action -Data $null -ErrorMessage $detail -ExitCode 1)
    exit 1
}

