param(
    [ValidateSet("status", "start", "continue", "latest")]
    [string]$Action = "status",
    [string]$Prompt,
    [string]$SessionId,
    [string]$SinceIso,
    [string]$Workdir = "D:\dev\vocabulary-study",
    [string]$CodexExe = "codex",
    [int]$TailLines = 1200
)

$ErrorActionPreference = "Stop"
Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $false -Scope Script -ErrorAction SilentlyContinue

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $ScriptDir ".state"
$LogDir = Join-Path $ScriptDir "logs"
$BridgeLogDir = Join-Path $LogDir "codex-bridge"
$LastSessionIdFile = Join-Path $StateDir "codex-last-session-id.txt"

function Ensure-Dir {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-SavedSessionId {
    if (-not (Test-Path $LastSessionIdFile)) {
        return $null
    }
    try {
        $id = (Get-Content -Path $LastSessionIdFile -Raw -ErrorAction Stop).Trim()
        if ([string]::IsNullOrWhiteSpace($id)) {
            return $null
        }
        return $id
    }
    catch {
        return $null
    }
}

function Save-SessionId {
    param([string]$Id)

    if ([string]::IsNullOrWhiteSpace($Id)) {
        return
    }

    try {
        Set-Content -Path $LastSessionIdFile -Value $Id.Trim() -Encoding ascii
    }
    catch {
    }
}

function Try-ParseJsonLine {
    param([string]$Line)
    if ([string]::IsNullOrWhiteSpace($Line)) {
        return $null
    }

    try {
        return $Line | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Resolve-SinceUtc {
    param([string]$InputIso)

    if ([string]::IsNullOrWhiteSpace($InputIso)) {
        return $null
    }

    try {
        return ([DateTimeOffset]::Parse($InputIso).ToUniversalTime())
    }
    catch {
        throw "Invalid SinceIso: $InputIso"
    }
}

function Parse-LineTimestampUtc {
    param([object]$Obj)

    if (-not $Obj -or -not $Obj.timestamp) {
        return $null
    }

    try {
        return ([DateTimeOffset]::Parse([string]$Obj.timestamp).ToUniversalTime())
    }
    catch {
        return $null
    }
}

function Resolve-SinceUtcFromObject {
    param([object]$InputValue)

    if ($null -eq $InputValue) {
        return $null
    }

    if ($InputValue -is [DateTimeOffset]) {
        return $InputValue.ToUniversalTime()
    }

    if ($InputValue -is [Nullable[DateTimeOffset]]) {
        if ($InputValue.HasValue) {
            return $InputValue.Value.ToUniversalTime()
        }
        return $null
    }

    $rawText = [string]$InputValue
    if ([string]::IsNullOrWhiteSpace($rawText)) {
        return $null
    }

    try {
        return ([DateTimeOffset]::Parse($rawText).ToUniversalTime())
    }
    catch {
        return $null
    }
}

function Normalize-WorkdirText {
    param([string]$PathText)

    if ([string]::IsNullOrWhiteSpace($PathText)) {
        return ""
    }

    try {
        return ([System.IO.Path]::GetFullPath($PathText)).Trim().TrimEnd('\\').ToLowerInvariant()
    }
    catch {
        return $PathText.Trim().TrimEnd('\\').ToLowerInvariant()
    }
}

function Get-LatestAssistantMessageFromRunLog {
    param(
        [string]$Path,
        [int]$Tail = 1200,
        [Nullable[DateTimeOffset]]$SinceUtc = $null
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    $lines = Get-Content -Path $Path -Tail $Tail -ErrorAction SilentlyContinue
    $latest = $null
    $latestTs = $null

    $effectiveSinceUtc = Resolve-SinceUtcFromObject -InputValue $SinceUtc

    foreach ($line in $lines) {
        $obj = Try-ParseJsonLine -Line $line
        if (-not $obj) {
            continue
        }

        $candidate = $null

        if ($obj.type -eq "item.completed" -and $obj.item -and $obj.item.type -eq "agent_message" -and $obj.item.text) {
            $candidate = [string]$obj.item.text
        }
        elseif ($obj.type -eq "event_msg" -and $obj.payload -and $obj.payload.type -eq "agent_message" -and $obj.payload.message) {
            $candidate = [string]$obj.payload.message
        }
        elseif ($obj.type -eq "response_item" -and $obj.payload -and $obj.payload.type -eq "item.completed" -and $obj.payload.item -and $obj.payload.item.type -eq "agent_message" -and $obj.payload.item.text) {
            $candidate = [string]$obj.payload.item.text
        }
        elseif ($obj.type -eq "response_item" -and $obj.payload -and $obj.payload.type -eq "message" -and $obj.payload.role -eq "assistant") {
            $parts = @()
            foreach ($item in @($obj.payload.content)) {
                if ($item.type -eq "output_text" -and $item.text) {
                    $parts += [string]$item.text
                }
            }
            if ($parts.Count -gt 0) {
                $candidate = ($parts -join "`n")
            }
        }

        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        $lineTs = Parse-LineTimestampUtc -Obj $obj
        if ($effectiveSinceUtc) {
            if (-not $lineTs) {
                continue
            }
            if ($lineTs -le $effectiveSinceUtc) {
                continue
            }
        }

        $latest = $candidate
        if ($lineTs) {
            $latestTs = $lineTs.ToString("o")
        }
    }

    return [pscustomobject]@{
        text = $latest
        timestamp = $latestTs
    }
}

function Resolve-LatestBridgeLog {
    $files = @(Get-ChildItem -Path $BridgeLogDir -File -Filter "codex-*.jsonl" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
    if ($files.Count -eq 0) {
        return $null
    }
    return $files[0].FullName
}

function Get-SessionFiles {
    param([string]$ExpectedWorkdir = "")

    $root = Join-Path $env:USERPROFILE ".codex\sessions"
    if (-not (Test-Path $root)) {
        return @()
    }

    $all = @(Get-ChildItem -Path $root -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)

    $expectedNorm = Normalize-WorkdirText -PathText $ExpectedWorkdir
    if ([string]::IsNullOrWhiteSpace($expectedNorm)) {
        return $all
    }

    return @($all | Where-Object {
            Test-SessionFileWorkdirMatch -Path $_.FullName -ExpectedWorkdir $expectedNorm
        })
}

function Get-SessionIdFromFileName {
    param([string]$Path)

    if ($Path -match "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$") {
        return $matches[1].ToLowerInvariant()
    }

    return $null
}

function Get-SessionIdFromFileContent {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return $null
    }

    $lines = Get-Content -Path $Path -TotalCount 40 -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
        $obj = Try-ParseJsonLine -Line $line
        if (-not $obj) {
            if ($line -match '"id":"([0-9a-fA-F-]{36})"') {
                return [string]$matches[1]
            }
            continue
        }
        if ($obj.type -eq "session_meta" -and $obj.payload -and $obj.payload.id) {
            return [string]$obj.payload.id
        }
    }

    return $null
}

function Get-SessionWorkdirFromFileContent {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return $null
    }

    $lines = Get-Content -Path $Path -TotalCount 40 -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
        $obj = Try-ParseJsonLine -Line $line
        if (-not $obj) {
            if ($line -match '"cwd":"([^"\\]*(?:\\.[^"\\]*)*)"') {
                try {
                    return [Regex]::Unescape([string]$matches[1])
                }
                catch {
                }
            }
            continue
        }
        if ($obj.type -eq "session_meta" -and $obj.payload -and $obj.payload.cwd) {
            return [string]$obj.payload.cwd
        }
    }

    return $null
}

function Test-SessionFileWorkdirMatch {
    param(
        [string]$Path,
        [string]$ExpectedWorkdir
    )

    $expected = Normalize-WorkdirText -PathText $ExpectedWorkdir
    if ([string]::IsNullOrWhiteSpace($expected)) {
        return $true
    }

    $cwdRaw = Get-SessionWorkdirFromFileContent -Path $Path
    $cwdNorm = Normalize-WorkdirText -PathText $cwdRaw
    if ([string]::IsNullOrWhiteSpace($cwdNorm)) {
        return $false
    }

    if ($cwdNorm -eq $expected) {
        return $true
    }

    if ($cwdNorm.StartsWith(($expected + "\\"))) {
        return $true
    }

    return $false
}

function Resolve-SessionId {
    param([string]$Path)

    $fromName = Get-SessionIdFromFileName -Path $Path
    if ($fromName) {
        return $fromName
    }

    return (Get-SessionIdFromFileContent -Path $Path)
}

function Resolve-SessionFile {
    param([string]$DesiredSessionId)

    $files = Get-SessionFiles -ExpectedWorkdir $Workdir
    if ($files.Count -eq 0) {
        return $null
    }

    if (-not $DesiredSessionId) {
        return $files[0].FullName
    }

    $id = $DesiredSessionId.Trim().ToLowerInvariant()
    if (-not $id) {
        return $files[0].FullName
    }

    foreach ($file in $files) {
        $sid = Resolve-SessionId -Path $file.FullName
        if ($sid -and $sid.ToLowerInvariant() -eq $id) {
            return $file.FullName
        }
    }

    foreach ($file in $files) {
        if ($file.Name.ToLowerInvariant().Contains($id)) {
            return $file.FullName
        }
    }

    return $null
}

function Get-LatestAssistantMessageFromSession {
    param(
        [string]$Path,
        [int]$Tail = 1200,
        [Nullable[DateTimeOffset]]$SinceUtc = $null
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    $lines = Get-Content -Path $Path -Tail $Tail -ErrorAction SilentlyContinue
    $latest = $null
    $latestTs = $null

    $effectiveSinceUtc = Resolve-SinceUtcFromObject -InputValue $SinceUtc

    foreach ($line in $lines) {
        $obj = Try-ParseJsonLine -Line $line
        if (-not $obj) {
            continue
        }

        $candidate = $null
        if ($obj.type -eq "event_msg" -and $obj.payload -and $obj.payload.type -eq "agent_message" -and $obj.payload.message) {
            $candidate = [string]$obj.payload.message
        }
        elseif ($obj.type -eq "response_item" -and $obj.payload -and $obj.payload.type -eq "item.completed" -and $obj.payload.item -and $obj.payload.item.type -eq "agent_message" -and $obj.payload.item.text) {
            $candidate = [string]$obj.payload.item.text
        }
        elseif ($obj.type -eq "response_item" -and $obj.payload -and $obj.payload.type -eq "message" -and $obj.payload.role -eq "assistant") {
            $parts = @()
            foreach ($item in @($obj.payload.content)) {
                if ($item.type -eq "output_text" -and $item.text) {
                    $parts += [string]$item.text
                }
            }

            if ($parts.Count -gt 0) {
                $candidate = ($parts -join "`n")
            }
        }

        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        $lineTs = Parse-LineTimestampUtc -Obj $obj
        if ($effectiveSinceUtc) {
            if (-not $lineTs) {
                continue
            }
            if ($lineTs -le $effectiveSinceUtc) {
                continue
            }
        }

        $latest = $candidate
        if ($lineTs) {
            $latestTs = $lineTs.ToString("o")
        }
    }

    return [pscustomobject]@{
        text = $latest
        timestamp = $latestTs
    }
}

function Get-LatestAssistantAcrossSessions {
    param(
        [Nullable[DateTimeOffset]]$SinceUtc = $null,
        [int]$Tail = 1200
    )

    $files = Get-SessionFiles -ExpectedWorkdir $Workdir
    if ($files.Count -eq 0) {
        return $null
    }

    $bestText = $null
    $bestTsObj = $null
    $bestTsText = $null
    $bestSid = $null
    $bestFile = $null

    foreach ($file in $files) {
        $msg = Get-LatestAssistantMessageFromSession -Path $file.FullName -Tail $Tail -SinceUtc $SinceUtc
        if (-not $msg -or [string]::IsNullOrWhiteSpace($msg.text)) {
            continue
        }

        $candidateTsObj = $null
        if (-not [string]::IsNullOrWhiteSpace($msg.timestamp)) {
            try {
                $candidateTsObj = ([DateTimeOffset]::Parse([string]$msg.timestamp).ToUniversalTime())
            }
            catch {
                $candidateTsObj = $null
            }
        }

        $use = $false
        if (-not $bestText) {
            $use = $true
        }
        elseif ($candidateTsObj -and -not $bestTsObj) {
            $use = $true
        }
        elseif ($candidateTsObj -and $bestTsObj -and $candidateTsObj -gt $bestTsObj) {
            $use = $true
        }

        if ($use) {
            $bestText = [string]$msg.text
            $bestTsObj = $candidateTsObj
            $bestTsText = if ($candidateTsObj) { $candidateTsObj.ToString("o") } else { [string]$msg.timestamp }
            $bestFile = $file.FullName
            $bestSid = Resolve-SessionId -Path $file.FullName
        }
    }

    if (-not $bestText) {
        return $null
    }

    return [pscustomobject]@{
        session_id = $bestSid
        session_file = $bestFile
        latest_assistant = $bestText
        latest_assistant_timestamp = $bestTsText
    }
}

function New-Result {
    param(
        [string]$ActionName,
        [bool]$Ok,
        [int]$ExitCode,
        [string]$SessionIdValue,
        [string]$SessionFile,
        [string]$LatestAssistant,
        [string]$LatestAssistantTimestamp,
        [string]$StdoutLog,
        [string]$ErrorMessage
    )

    $result = [ordered]@{
        action = $ActionName
        ok = $Ok
        exit_code = $ExitCode
        session_id = $SessionIdValue
        session_file = $SessionFile
        latest_assistant = $LatestAssistant
        latest_assistant_timestamp = $LatestAssistantTimestamp
        stdout_log = $StdoutLog
        workdir = $Workdir
        timestamp = (Get-Date).ToString("o")
    }

    if (-not [string]::IsNullOrWhiteSpace($SinceIso)) {
        $result.since = $SinceIso
    }

    if ($ErrorMessage) {
        $result.error = $ErrorMessage
    }

    return ($result | ConvertTo-Json -Depth 10)
}

Ensure-Dir -Path $StateDir
Ensure-Dir -Path $LogDir
Ensure-Dir -Path $BridgeLogDir

if (-not (Get-Command $CodexExe -ErrorAction SilentlyContinue)) {
    throw "codex command not found"
}

$codexCommand = Get-Command $CodexExe -ErrorAction SilentlyContinue
$codexPath = $codexCommand.Source
if (-not $codexPath) {
    $codexPath = $CodexExe
}
$sinceUtc = Resolve-SinceUtc -InputIso $SinceIso

if ($Action -eq "status") {
    $file = Resolve-SessionFile -DesiredSessionId $SessionId
    $sid = $null
    $latest = $null
    $latestTs = $null

    if (($sinceUtc -ne $null) -and [string]::IsNullOrWhiteSpace($SessionId)) {
        $cross = Get-LatestAssistantAcrossSessions -SinceUtc $sinceUtc -Tail $TailLines
        if ($cross) {
            $sid = $cross.session_id
            $file = $cross.session_file
            $latest = $cross.latest_assistant
            $latestTs = $cross.latest_assistant_timestamp
        }
    }

    if ($file) {
        if ([string]::IsNullOrWhiteSpace($sid)) {
            $sid = Resolve-SessionId -Path $file
        }
        if ([string]::IsNullOrWhiteSpace($latest)) {
            $latestMsg = Get-LatestAssistantMessageFromSession -Path $file -Tail $TailLines -SinceUtc $sinceUtc
            $latest = $latestMsg.text
            $latestTs = $latestMsg.timestamp
        }
        if ([string]::IsNullOrWhiteSpace($latest)) {
            $latestLog = Resolve-LatestBridgeLog
            if ($latestLog) {
                $latestMsg = Get-LatestAssistantMessageFromRunLog -Path $latestLog -Tail $TailLines -SinceUtc $sinceUtc
                $latest = $latestMsg.text
                $latestTs = $latestMsg.timestamp
            }
        }
    }

    Write-Output (New-Result -ActionName "status" -Ok $true -ExitCode 0 -SessionIdValue $sid -SessionFile $file -LatestAssistant $latest -LatestAssistantTimestamp $latestTs -StdoutLog $null -ErrorMessage $null)
    exit 0
}

if ($Action -eq "latest") {
    $file = Resolve-SessionFile -DesiredSessionId $SessionId
    $sid = $null
    $latestTs = $null

    if (($sinceUtc -ne $null) -and [string]::IsNullOrWhiteSpace($SessionId)) {
        $cross = Get-LatestAssistantAcrossSessions -SinceUtc $sinceUtc -Tail $TailLines
        if ($cross) {
            $sid = $cross.session_id
            $file = $cross.session_file
            $latest = $cross.latest_assistant
            $latestTs = $cross.latest_assistant_timestamp
        }
    }

    if (-not $file) {
        Write-Output (New-Result -ActionName "latest" -Ok $false -ExitCode 1 -SessionIdValue $null -SessionFile $null -LatestAssistant $null -LatestAssistantTimestamp $null -StdoutLog $null -ErrorMessage "No Codex session file found")
        exit 1
    }

    if ([string]::IsNullOrWhiteSpace($sid)) {
        $sid = Resolve-SessionId -Path $file
    }
    if ([string]::IsNullOrWhiteSpace($latest)) {
        $latestMsg = Get-LatestAssistantMessageFromSession -Path $file -Tail $TailLines -SinceUtc $sinceUtc
        $latest = $latestMsg.text
        $latestTs = $latestMsg.timestamp
    }
    if ([string]::IsNullOrWhiteSpace($latest)) {
        $latestLog = Resolve-LatestBridgeLog
        if ($latestLog) {
            $latestMsg = Get-LatestAssistantMessageFromRunLog -Path $latestLog -Tail $TailLines -SinceUtc $sinceUtc
            $latest = $latestMsg.text
            $latestTs = $latestMsg.timestamp
        }
    }
    $ok = -not [string]::IsNullOrWhiteSpace($latest)

    Write-Output (New-Result -ActionName "latest" -Ok $ok -ExitCode ($(if ($ok) { 0 } else { 2 })) -SessionIdValue $sid -SessionFile $file -LatestAssistant $latest -LatestAssistantTimestamp $latestTs -StdoutLog $null -ErrorMessage $(if ($ok) { $null } else { "No assistant output found in session tail" }))
    if ($ok) { exit 0 } else { exit 2 }
}

if ([string]::IsNullOrWhiteSpace($Prompt)) {
    Write-Output (New-Result -ActionName $Action -Ok $false -ExitCode 2 -SessionIdValue $null -SessionFile $null -LatestAssistant $null -LatestAssistantTimestamp $null -StdoutLog $null -ErrorMessage "Prompt is required for start/continue")
    exit 2
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$prefix = if ($Action -eq "start") { "codex-start" } else { "codex-continue" }
$stdoutLog = Join-Path $BridgeLogDir "$prefix-$stamp.jsonl"
$before = Get-Date

$args = @()
if ($Action -eq "start") {
    $args = @("exec", "--json", "--skip-git-repo-check", "-C", $Workdir, $Prompt)
}
elseif ($Action -eq "continue") {
    $args = @("exec", "resume", "--json", "--skip-git-repo-check")
    $effectiveSessionId = $SessionId
    if ([string]::IsNullOrWhiteSpace($effectiveSessionId)) {
        $effectiveSessionId = Get-SavedSessionId
    }
    if ([string]::IsNullOrWhiteSpace($effectiveSessionId)) {
        $args += "--last"
    }
    else {
        $args += $effectiveSessionId.Trim()
    }
    $args += $Prompt
}

$exitCode = 0
$errorMessage = $null

$tempStdOut = "$stdoutLog.stdout"
$tempStdErr = "$stdoutLog.stderr"

try {
    & $codexPath @args 1> $tempStdOut 2> $tempStdErr
    $exitCode = $LASTEXITCODE

    if (Test-Path $tempStdOut) {
        Get-Content -Path $tempStdOut -ErrorAction SilentlyContinue | Set-Content -Path $stdoutLog -Encoding utf8
    }

    if (Test-Path $tempStdErr) {
        Get-Content -Path $tempStdErr -ErrorAction SilentlyContinue | Add-Content -Path $stdoutLog -Encoding utf8
    }

    if ($exitCode -ne 0) {
        $tailErr = @()
        if (Test-Path $tempStdErr) {
            $tailErr = @(Get-Content -Path $tempStdErr -Tail 5 -ErrorAction SilentlyContinue)
        }
        if ($tailErr.Count -eq 0 -and (Test-Path $tempStdOut)) {
            $tailErr = @(Get-Content -Path $tempStdOut -Tail 5 -ErrorAction SilentlyContinue)
        }
        if ($tailErr.Count -gt 0) {
            $errorMessage = ($tailErr -join "`n")
        }
    }
}
catch {
    $exitCode = 1
    $errorMessage = $_.Exception.Message
}
finally {
    Remove-Item -Path $tempStdOut -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $tempStdErr -Force -ErrorAction SilentlyContinue
}

$sessionFile = $null
$all = Get-SessionFiles
$newer = @($all | Where-Object { $_.LastWriteTime -ge $before })
if ($newer.Count -gt 0) {
    $sessionFile = $newer[0].FullName
}
elseif ($all.Count -gt 0) {
    $sessionFile = $all[0].FullName
}

$sid = $null
$latest = $null
$latestTs = $null
if ($sessionFile) {
    $sid = Resolve-SessionId -Path $sessionFile
    $latestMsg = Get-LatestAssistantMessageFromSession -Path $sessionFile -Tail $TailLines
    $latest = $latestMsg.text
    $latestTs = $latestMsg.timestamp
}

if ([string]::IsNullOrWhiteSpace($latest)) {
    $latestMsg = Get-LatestAssistantMessageFromRunLog -Path $stdoutLog -Tail $TailLines
    $latest = $latestMsg.text
    $latestTs = $latestMsg.timestamp
}

Save-SessionId -Id $sid

$ok = ($exitCode -eq 0)
Write-Output (New-Result -ActionName $Action -Ok $ok -ExitCode $exitCode -SessionIdValue $sid -SessionFile $sessionFile -LatestAssistant $latest -LatestAssistantTimestamp $latestTs -StdoutLog $stdoutLog -ErrorMessage $errorMessage)
if ($ok) { exit 0 } else { exit $exitCode }
