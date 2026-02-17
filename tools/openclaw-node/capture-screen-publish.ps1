param(
    [string]$ServerHost = "47.254.195.180",
    [string]$ServerUser = "root",
    [string]$SshKeyPath = "$HOME\.ssh\fast-english_ed25519_20260204_220739",
    [string]$PublicBaseUrl = "http://openclaw.47.254.195.180.sslip.io/openclaw-shots"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw "ssh.exe not found"
}

if (-not (Get-Command scp.exe -ErrorAction SilentlyContinue)) {
    throw "scp.exe not found"
}

if (-not (Test-Path $SshKeyPath)) {
    throw "SSH private key not found: $SshKeyPath"
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

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$suffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$fileName = "screen-$ts-$suffix.png"
$localPath = Join-Path $env:TEMP $fileName

$screens = [System.Windows.Forms.Screen]::AllScreens
if (-not $screens -or $screens.Count -eq 0) {
    throw "No screens detected"
}

$left = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
$top = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
$right = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
$bottom = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum

$width = [int]($right - $left)
$height = [int]($bottom - $top)
if ($width -le 0 -or $height -le 0) {
    throw "Invalid virtual screen bounds: width=$width height=$height"
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

foreach ($screen in $screens) {
    $bounds = $screen.Bounds
    $destX = $bounds.Left - $left
    $destY = $bounds.Top - $top
    $graphics.CopyFromScreen(
        $bounds.Left,
        $bounds.Top,
        $destX,
        $destY,
        $bounds.Size,
        [System.Drawing.CopyPixelOperation]::SourceCopy
    )
}

$bitmap.Save($localPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

scp.exe -i $SshKeyPath $localPath "${ServerUser}@${ServerHost}:/tmp/$fileName" | Out-Null

$remoteCmd = "docker exec fast-english-gateway sh -lc 'mkdir -p /usr/share/nginx/html/openclaw-shots' && docker cp /tmp/$fileName fast-english-gateway:/usr/share/nginx/html/openclaw-shots/$fileName && rm -f /tmp/$fileName"
ssh.exe -i $SshKeyPath "${ServerUser}@${ServerHost}" $remoteCmd | Out-Null

Remove-Item -Path $localPath -Force -ErrorAction SilentlyContinue

$url = "$PublicBaseUrl/$fileName"
Write-Output $url
