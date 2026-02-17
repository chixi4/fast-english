param(
    [ValidateSet("list_windows", "open_codex", "send_text", "latest_output", "run_and_report", "capture_window")]
    [string]$Action = "list_windows",
    [string]$Workdir = "D:\dev\vocabulary-study",
    [string]$WindowQuery = "codex",
    [Int64]$WindowHwnd = 0,
    [int]$WindowPid = 0,
    [string]$Text,
    [string]$SessionId,
    [string]$SinceIso,
    [string]$Model = "gpt-5.3-codex",
    [string]$UseYolo = "true",
    [string]$UseLastRequest = "true",
    [string]$FocusBeforeCapture = "true",
    [string]$PressEnter = "true",
    [string]$ServerHost = "47.254.195.180",
    [string]$ServerUser = "root",
    [string]$SshKeyPath = "$HOME\.ssh\fast-english_ed25519_20260204_220739",
    [string]$PublicBaseUrl = "http://openclaw.47.254.195.180.sslip.io/openclaw-shots",
    [int]$WindowPadding = 0,
    [int]$WaitMs = 900,
    [int]$TailLines = 1200
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeScript = Join-Path $ScriptDir "codex-bridge.ps1"
$StateDir = Join-Path $ScriptDir ".state"
$LastWindowRequestFile = Join-Path $StateDir "codex-window-last-request.json"

if (-not ("WindowNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WindowNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
}

if (-not ("DpiAwareNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DpiAwareNative
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    [DllImport("shcore.dll", SetLastError = true)]
    public static extern int SetProcessDpiAwareness(int awareness);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr dpiContext);
}
"@
}

function Enable-DpiAwareness {
    try {
        [void][DpiAwareNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
    }
    catch {
    }

    try {
        [void][DpiAwareNative]::SetProcessDpiAwareness(2)
    }
    catch {
    }

    try {
        [void][DpiAwareNative]::SetProcessDPIAware()
    }
    catch {
    }
}

Enable-DpiAwareness
Add-Type -AssemblyName System.Drawing

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

    return ($obj | ConvertTo-Json -Depth 10)
}

function To-Bool {
    param(
        [string]$Value,
        [bool]$Default = $false
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Default
    }

    $v = $Value.Trim().ToLowerInvariant()
    if ($v -in @("1", "true", "yes", "y", "on")) {
        return $true
    }
    if ($v -in @("0", "false", "no", "n", "off")) {
        return $false
    }
    return $Default
}

function Ensure-Dir {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Load-LastWindowRequest {
    if (-not (Test-Path $LastWindowRequestFile)) {
        return $null
    }

    try {
        return (Get-Content -Path $LastWindowRequestFile -Raw -ErrorAction Stop | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Save-LastWindowRequest {
    param([object]$Tracker)

    if (-not $Tracker) {
        return
    }

    Ensure-Dir -Path $StateDir
    $json = $Tracker | ConvertTo-Json -Depth 10
    Set-Content -Path $LastWindowRequestFile -Value $json -Encoding utf8
}

function Get-TextPreview {
    param(
        [string]$InputText,
        [int]$MaxLength = 120
    )

    if ([string]::IsNullOrWhiteSpace($InputText)) {
        return ""
    }

    $clean = $InputText.Replace("`r", " ").Replace("`n", " ")
    if ($clean.Length -le $MaxLength) {
        return $clean
    }

    return ($clean.Substring(0, $MaxLength) + "...")
}

function Ensure-FileParent {
    param([string]$FilePath)

    $parent = Split-Path -Parent $FilePath
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
}

function Get-WindowRectObject {
    param([object]$Window)

    if (-not $Window) {
        return $null
    }

    $h = [IntPtr]::new([Int64]$Window.hwnd)
    $rect = New-Object WindowNative+RECT
    $ok = [WindowNative]::GetWindowRect($h, [ref]$rect)
    if (-not $ok) {
        return $null
    }

    $width = [int]($rect.Right - $rect.Left)
    $height = [int]($rect.Bottom - $rect.Top)
    if ($width -le 0 -or $height -le 0) {
        return $null
    }

    return [pscustomobject]@{
        left = [int]$rect.Left
        top = [int]$rect.Top
        right = [int]$rect.Right
        bottom = [int]$rect.Bottom
        width = $width
        height = $height
    }
}

function Upload-WindowImageAndGetUrl {
    param(
        [string]$LocalPath,
        [string]$RemoteFileName
    )

    if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
        throw "ssh.exe not found"
    }
    if (-not (Get-Command scp.exe -ErrorAction SilentlyContinue)) {
        throw "scp.exe not found"
    }
    if (-not (Test-Path $SshKeyPath)) {
        throw "SSH private key not found: $SshKeyPath"
    }

    scp.exe -i $SshKeyPath $LocalPath "${ServerUser}@${ServerHost}:/tmp/$RemoteFileName" | Out-Null
    $remoteCmd = "docker exec fast-english-gateway sh -lc 'mkdir -p /usr/share/nginx/html/openclaw-shots' && docker cp /tmp/$RemoteFileName fast-english-gateway:/usr/share/nginx/html/openclaw-shots/$RemoteFileName && rm -f /tmp/$RemoteFileName"
    ssh.exe -i $SshKeyPath "${ServerUser}@${ServerHost}" $remoteCmd | Out-Null

    return "$PublicBaseUrl/$RemoteFileName"
}

function Capture-WindowAndPublish {
    param(
        [object]$Window,
        [int]$Padding = 0,
        [bool]$FocusFirst = $true
    )

    if (-not $Window) {
        throw "Window is null"
    }

    if ($FocusFirst) {
        [void](Focus-Window -Window $Window)
        Start-Sleep -Milliseconds 180
    }

    $rect = Get-WindowRectObject -Window $Window
    if (-not $rect) {
        throw "Failed to get window rect"
    }

    $left = $rect.left - $Padding
    $top = $rect.top - $Padding
    $width = $rect.width + ($Padding * 2)
    $height = $rect.height + ($Padding * 2)

    if ($width -le 0 -or $height -le 0) {
        throw "Invalid capture size"
    }

    $ts = Get-Date -Format "yyyyMMdd-HHmmss"
    $suffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
    $remoteFileName = "window-$ts-$suffix.png"
    $localPath = Join-Path $env:TEMP $remoteFileName
    Ensure-FileParent -FilePath $localPath

    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen(
        $left,
        $top,
        0,
        0,
        (New-Object System.Drawing.Size($width, $height)),
        [System.Drawing.CopyPixelOperation]::SourceCopy
    )

    try {
        $bitmap.Save($localPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    try {
        $url = Upload-WindowImageAndGetUrl -LocalPath $localPath -RemoteFileName $remoteFileName
    }
    finally {
        Remove-Item -Path $localPath -Force -ErrorAction SilentlyContinue
    }

    return [pscustomobject]@{
        url = $url
        file_name = $remoteFileName
        rect = [pscustomobject]@{
            left = $left
            top = $top
            width = $width
            height = $height
        }
    }
}

function Get-WindowTitle {
    param([IntPtr]$Handle)

    $len = [WindowNative]::GetWindowTextLength($Handle)
    if ($len -le 0) {
        return ""
    }
    $sb = New-Object System.Text.StringBuilder($len + 2)
    [void][WindowNative]::GetWindowText($Handle, $sb, $sb.Capacity)
    return $sb.ToString()
}

function Test-CodexProcessSignal {
    param([object]$Proc)

    if (-not $Proc) {
        return $false
    }

    $name = if ($Proc.Name) { ([string]$Proc.Name).ToLowerInvariant() } else { "" }
    $cmd = if ($Proc.CommandLine) { ([string]$Proc.CommandLine).ToLowerInvariant() } else { "" }

    if ($name.Contains("codex")) {
        return $true
    }

    if (
        $cmd.Contains("codex.js") -or
        $cmd.Contains("@openai\\codex") -or
        $cmd.Contains(" codex ") -or
        $cmd.Contains("gpt-5.3-codex")
    ) {
        return $true
    }

    return $false
}

function Get-ProcessMeta {
    param(
        [int]$ProcessId,
        [hashtable]$Cache
    )

    if (-not $Cache) {
        return $null
    }

    if ($Cache.ContainsKey($ProcessId)) {
        return $Cache[$ProcessId]
    }

    $meta = [pscustomobject]@{
        process_name = $null
        command_line = $null
        descendant_codex_likely = $false
        descendant_codex_hint = $null
    }

    try {
        $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop | Select-Object -First 1
        if ($proc) {
            $meta.process_name = $proc.Name
            $meta.command_line = $proc.CommandLine
            $meta.descendant_codex_likely = Test-CodexProcessSignal -Proc $proc
            if ($meta.descendant_codex_likely -and $proc.CommandLine) {
                $meta.descendant_codex_hint = [string]$proc.CommandLine
            }
        }
    }
    catch {
    }

    $Cache[$ProcessId] = $meta
    return $meta
}

function Get-VisibleWindows {
    $list = New-Object System.Collections.ArrayList
    $procCache = @{}

    $callback = [WindowNative+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)

        if (-not [WindowNative]::IsWindowVisible($hWnd)) {
            return $true
        }

        $title = Get-WindowTitle -Handle $hWnd
        if ([string]::IsNullOrWhiteSpace($title)) {
            return $true
        }

        [uint32]$processIdValue = 0
        [void][WindowNative]::GetWindowThreadProcessId($hWnd, [ref]$processIdValue)

        $meta = Get-ProcessMeta -ProcessId ([int]$processIdValue) -Cache $procCache

        [void]$list.Add([pscustomobject]@{
            hwnd = [Int64]$hWnd
            pid = [int]$processIdValue
            title = $title
            process_name = if ($meta) { $meta.process_name } else { $null }
            command_line = if ($meta) { $meta.command_line } else { $null }
            descendant_codex_likely = if ($meta) { $meta.descendant_codex_likely } else { $false }
            descendant_codex_hint = if ($meta) { $meta.descendant_codex_hint } else { $null }
            codex_likely = (
                $title.ToLowerInvariant().Contains("codex") -or
                $title.ToLowerInvariant().Contains("gpt-5.3-codex") -or
                ($(if ($meta -and $meta.command_line) { [string]$meta.command_line } else { "" }).ToLowerInvariant().Contains("codex"))
            )
        })

        return $true
    }

    [void][WindowNative]::EnumWindows($callback, [IntPtr]::Zero)
    return @($list)
}

function Get-ForegroundWindowInfo {
    $h = [WindowNative]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) {
        return $null
    }

    $title = Get-WindowTitle -Handle $h
    [uint32]$processIdValue = 0
    [void][WindowNative]::GetWindowThreadProcessId($h, [ref]$processIdValue)

    return [pscustomobject]@{
        hwnd = [Int64]$h
        pid = [int]$processIdValue
        title = $title
    }
}

function Find-WindowByQuery {
    param([string]$Query)

    $windows = Get-VisibleWindows
    if ([string]::IsNullOrWhiteSpace($Query)) {
        $fg = Get-ForegroundWindowInfo
        if ($fg) {
            return $fg
        }
        return $null
    }

    $needle = $Query.Trim().ToLowerInvariant()
    foreach ($w in $windows) {
        if ($w.title.ToLowerInvariant().Contains($needle)) {
            return $w
        }
    }

    return $null
}

function Select-BestWindowCandidate {
    param(
        [object[]]$Candidates,
        [string]$Query
    )

    if (-not $Candidates -or $Candidates.Count -eq 0) {
        return $null
    }

    if (-not [string]::IsNullOrWhiteSpace($Query)) {
        $needle = $Query.Trim().ToLowerInvariant()
        $matched = @($Candidates | Where-Object {
                ([string]$_.title).ToLowerInvariant().Contains($needle)
            })
        if ($matched.Count -gt 0) {
            return $matched[0]
        }
    }

    $codexLike = @($Candidates | Where-Object { $_.codex_likely -eq $true })
    if ($codexLike.Count -gt 0) {
        return $codexLike[0]
    }

    $terminalLike = @($Candidates | Where-Object {
            $t = ([string]$_.title).ToLowerInvariant()
            $t.Contains("cmd.exe") -or $t.Contains("powershell")
        })
    if ($terminalLike.Count -gt 0) {
        return $terminalLike[0]
    }

    return $Candidates[0]
}

function Find-WindowByIdentity {
    param(
        [Int64]$Hwnd,
        [int]$TargetPid,
        [string]$Query
    )

    $windows = Get-VisibleWindows
    $strictHwndRequested = $Hwnd -gt 0

    if ($Hwnd -gt 0) {
        foreach ($w in $windows) {
            if ([Int64]$w.hwnd -eq $Hwnd) {
                return $w
            }
        }
    }

    if ($TargetPid -gt 0) {
        $byPid = @($windows | Where-Object { [int]$_.pid -eq $TargetPid })
        if ($byPid.Count -gt 0) {
            $bestByPid = Select-BestWindowCandidate -Candidates $byPid -Query $Query
            if ($bestByPid) {
                return $bestByPid
            }
        }
    }

    if ($strictHwndRequested) {
        return $null
    }

    if (-not [string]::IsNullOrWhiteSpace($Query)) {
        return (Find-WindowByQuery -Query $Query)
    }

    return (Get-ForegroundWindowInfo)
}

function Focus-Window {
    param([object]$Window)

    if (-not $Window) {
        return $false
    }

    $h = [IntPtr]::new([Int64]$Window.hwnd)
    [void][WindowNative]::ShowWindowAsync($h, 9)
    Start-Sleep -Milliseconds 140

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate([int]$Window.pid)
    }
    catch {
    }

    Start-Sleep -Milliseconds 120
    return [WindowNative]::SetForegroundWindow($h)
}

function Send-TextToFocusedWindow {
    param(
        [string]$InputText,
        [bool]$NeedEnter
    )

    if ([string]::IsNullOrWhiteSpace($InputText)) {
        throw "Text is empty"
    }

    $shell = New-Object -ComObject WScript.Shell

    $clipboardOld = $null
    try {
        $clipboardOld = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    }
    catch {
    }

    Set-Clipboard -Value $InputText
    Start-Sleep -Milliseconds 60
    $shell.SendKeys("^v")

    if ($NeedEnter) {
        Start-Sleep -Milliseconds 60
        $shell.SendKeys("{ENTER}")
    }

    if ($clipboardOld -ne $null) {
        try {
            Set-Clipboard -Value $clipboardOld
        }
        catch {
        }
    }
}

function Get-CodexOpenCommand {
    param(
        [string]$ModelName,
        [bool]$Yolo
    )

    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
        throw "codex command not found"
    }

    $hasYolo = $false
    try {
        $helpText = & codex --help 2>$null
        $joined = ($helpText -join "`n")
        if ($joined -match "--yolo") {
            $hasYolo = $true
        }
    }
    catch {
    }

    if ($Yolo -and $hasYolo) {
        return "codex -m $ModelName --yolo"
    }

    if ($Yolo -and -not $hasYolo) {
        return "codex -m $ModelName --dangerously-bypass-approvals-and-sandbox"
    }

    return "codex -m $ModelName"
}

function Invoke-Bridge {
    param(
        [string]$BridgeAction,
        [string]$BridgePrompt,
        [string]$BridgeSessionId,
        [string]$BridgeSinceIso,
        [int]$BridgeTailLines
    )

    if (-not (Test-Path $BridgeScript)) {
        throw "Bridge script not found: $BridgeScript"
    }

    $args = @(
        "-ExecutionPolicy", "Bypass",
        "-File", $BridgeScript,
        "-Action", $BridgeAction,
        "-TailLines", "$BridgeTailLines",
        "-Workdir", $Workdir
    )

    if (-not [string]::IsNullOrWhiteSpace($BridgeSessionId)) {
        $args += @("-SessionId", $BridgeSessionId)
    }
    if (-not [string]::IsNullOrWhiteSpace($BridgeSinceIso)) {
        $args += @("-SinceIso", $BridgeSinceIso)
    }
    if (-not [string]::IsNullOrWhiteSpace($BridgePrompt)) {
        $args += @("-Prompt", $BridgePrompt)
    }

    $raw = & powershell.exe @args
    if ($LASTEXITCODE -ne 0 -and -not $raw) {
        throw "codex-bridge failed with code $LASTEXITCODE"
    }

    try {
        return ($raw | ConvertFrom-Json)
    }
    catch {
        return [pscustomobject]@{
            ok = $false
            action = $BridgeAction
            error = [string]$raw
        }
    }
}

function Find-LatestSessionIdByWorkdir {
    param([string]$WorkdirValue)

    if ([string]::IsNullOrWhiteSpace($WorkdirValue)) {
        return $null
    }

    $root = Join-Path $env:USERPROFILE ".codex\sessions"
    if (-not (Test-Path $root)) {
        return $null
    }

    $expected = ""
    try {
        $expected = ([System.IO.Path]::GetFullPath($WorkdirValue)).Trim().TrimEnd('\\').ToLowerInvariant()
    }
    catch {
        $expected = $WorkdirValue.Trim().TrimEnd('\\').ToLowerInvariant()
    }

    $files = @(Get-ChildItem -Path $root -Recurse -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
    foreach ($file in $files) {
        $head = Get-Content -Path $file.FullName -TotalCount 1 -ErrorAction SilentlyContinue
        if (-not $head) {
            continue
        }
        $line = [string]($head | Select-Object -First 1)
        if (-not ($line -match '"cwd":"([^"\\]*(?:\\.[^"\\]*)*)"')) {
            continue
        }
        $cwd = ""
        try {
            $cwd = [Regex]::Unescape([string]$matches[1])
        }
        catch {
            $cwd = [string]$matches[1]
        }

        $cwdNorm = ""
        try {
            $cwdNorm = ([System.IO.Path]::GetFullPath($cwd)).Trim().TrimEnd('\\').ToLowerInvariant()
        }
        catch {
            $cwdNorm = $cwd.Trim().TrimEnd('\\').ToLowerInvariant()
        }

        if ($cwdNorm -ne $expected -and -not $cwdNorm.StartsWith($expected + "\\")) {
            continue
        }

        if ($line -match '"id":"([0-9a-fA-F-]{36})"') {
            return [string]$matches[1]
        }
    }

    return $null
}

try {
    $useYoloBool = To-Bool -Value $UseYolo -Default $true
    $useLastRequestBool = To-Bool -Value $UseLastRequest -Default $true
    $pressEnterBool = To-Bool -Value $PressEnter -Default $true
    Ensure-Dir -Path $StateDir

    switch ($Action) {
        "list_windows" {
            $wins = Get-VisibleWindows
            $fg = Get-ForegroundWindowInfo
            $data = [pscustomobject]@{
                foreground = $fg
                count = $wins.Count
                windows = $wins
            }
            Write-Output (New-Result -Ok $true -ActionName $Action -Data $data -ErrorMessage $null)
            exit 0
        }

        "open_codex" {
            $openCmd = Get-CodexOpenCommand -ModelName $Model -Yolo $useYoloBool
            $cmdLine = "cd /d `"$Workdir`" && $openCmd"
            $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $cmdLine -PassThru -WindowStyle Normal

            Start-Sleep -Milliseconds $WaitMs
            $win = Find-WindowByIdentity -Hwnd 0 -TargetPid $proc.Id -Query ""
            if (-not $win) {
                $win = Find-WindowByQuery -Query "codex"
            }
            if (-not $win) {
                $win = Find-WindowByQuery -Query "cmd"
            }
            if ($win) {
                [void](Focus-Window -Window $win)
            }

            $data = [pscustomobject]@{
                pid = $proc.Id
                workdir = $Workdir
                command = $openCmd
                cmdline = $cmdLine
                focused_window = $win
            }
            Write-Output (New-Result -Ok $true -ActionName $Action -Data $data -ErrorMessage $null)
            exit 0
        }

        "send_text" {
            $target = Find-WindowByIdentity -Hwnd $WindowHwnd -TargetPid $WindowPid -Query $WindowQuery
            if (-not $target) {
                Write-Output (New-Result -Ok $false -ActionName $Action -Data $null -ErrorMessage "Window not found by hwnd/pid/query" -ExitCode 2)
                exit 2
            }

            $requestTimeUtc = (Get-Date).ToUniversalTime().ToString("o")
            $requestId = [Guid]::NewGuid().ToString()

            $effectiveSessionId = $SessionId
            if ([string]::IsNullOrWhiteSpace($effectiveSessionId)) {
                $effectiveSessionId = Find-LatestSessionIdByWorkdir -WorkdirValue $Workdir
            }

            [void](Focus-Window -Window $target)
            Start-Sleep -Milliseconds 120
            Send-TextToFocusedWindow -InputText $Text -NeedEnter $pressEnterBool

            $tracker = [ordered]@{
                request_id = $requestId
                request_time_utc = $requestTimeUtc
                window_query = $WindowQuery
                window_hwnd = if ($WindowHwnd -gt 0) { $WindowHwnd } else { $null }
                window_pid = if ($WindowPid -gt 0) { $WindowPid } else { $null }
                target_hwnd = [Int64]$target.hwnd
                target_pid = [int]$target.pid
                target_title = [string]$target.title
                press_enter = $pressEnterBool
                session_id = $effectiveSessionId
                text_preview = (Get-TextPreview -InputText $Text)
            }

            $bridgeStatus = $null
            if ($pressEnterBool) {
                try {
                    $bridgeStatus = Invoke-Bridge -BridgeAction "status" -BridgePrompt $null -BridgeSessionId $effectiveSessionId -BridgeSinceIso $requestTimeUtc -BridgeTailLines $TailLines
                    if ($bridgeStatus -and $bridgeStatus.session_id) {
                        $tracker.session_id = [string]$bridgeStatus.session_id
                    }
                }
                catch {
                }
                Save-LastWindowRequest -Tracker $tracker
            }

            $data = [pscustomobject]@{
                target = $target
                sent_text = $Text
                press_enter = $pressEnterBool
                tracker = $tracker
                bridge_status = $bridgeStatus
            }
            Write-Output (New-Result -Ok $true -ActionName $Action -Data $data -ErrorMessage $null)
            exit 0
        }

        "latest_output" {
            $lastTracker = $null
            $effectiveSessionId = $SessionId
            $effectiveSince = $SinceIso
            $usedLastRequest = $false

            if ($useLastRequestBool -and [string]::IsNullOrWhiteSpace($effectiveSessionId) -and [string]::IsNullOrWhiteSpace($effectiveSince)) {
                $lastTracker = Load-LastWindowRequest
                if ($lastTracker) {
                    if (-not [string]::IsNullOrWhiteSpace([string]$lastTracker.session_id)) {
                        $effectiveSessionId = [string]$lastTracker.session_id
                    }
                    if (-not [string]::IsNullOrWhiteSpace([string]$lastTracker.request_time_utc)) {
                        $effectiveSince = [string]$lastTracker.request_time_utc
                    }
                    $usedLastRequest = $true
                }
            }

            $bridgeRes = Invoke-Bridge -BridgeAction "latest" -BridgePrompt $null -BridgeSessionId $effectiveSessionId -BridgeSinceIso $effectiveSince -BridgeTailLines $TailLines

            if ($usedLastRequest -and $lastTracker -and $bridgeRes -and $bridgeRes.session_id) {
                $lastTracker.session_id = [string]$bridgeRes.session_id
                Save-LastWindowRequest -Tracker $lastTracker
            }

            $data = [pscustomobject]@{
                bridge = $bridgeRes
                effective_session_id = $effectiveSessionId
                effective_since = $effectiveSince
                used_last_request = $usedLastRequest
                last_request = $lastTracker
                requested_hwnd = if ($WindowHwnd -gt 0) { $WindowHwnd } else { $null }
                requested_pid = if ($WindowPid -gt 0) { $WindowPid } else { $null }
            }

            Write-Output (New-Result -Ok $true -ActionName $Action -Data $data -ErrorMessage $null)
            exit 0
        }

        "run_and_report" {
            if ([string]::IsNullOrWhiteSpace($Text)) {
                Write-Output (New-Result -Ok $false -ActionName $Action -Data $null -ErrorMessage "Text prompt is required" -ExitCode 2)
                exit 2
            }

            $bridgeAction = "start"
            if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
                $bridgeAction = "continue"
            }

            $bridgeRes = Invoke-Bridge -BridgeAction $bridgeAction -BridgePrompt $Text -BridgeSessionId $SessionId -BridgeSinceIso $null -BridgeTailLines $TailLines
            Write-Output (New-Result -Ok $true -ActionName $Action -Data $bridgeRes -ErrorMessage $null)
            exit 0
        }

        "capture_window" {
            $focusBeforeCaptureBool = To-Bool -Value $FocusBeforeCapture -Default $true
            $target = Find-WindowByIdentity -Hwnd $WindowHwnd -TargetPid $WindowPid -Query $WindowQuery
            if (-not $target) {
                Write-Output (New-Result -Ok $false -ActionName $Action -Data $null -ErrorMessage "Window not found by hwnd/pid/query" -ExitCode 2)
                exit 2
            }

            $capture = Capture-WindowAndPublish -Window $target -Padding $WindowPadding -FocusFirst $focusBeforeCaptureBool
            $data = [pscustomobject]@{
                target = $target
                focus_before_capture = $focusBeforeCaptureBool
                window_padding = $WindowPadding
                screenshot = $capture
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
