param()
$listRes = powershell.exe -ExecutionPolicy Bypass -File tools/openclaw-node/codex-window-control.ps1 -Action list_windows | ConvertFrom-Json
$all = @($listRes.data.windows)
$result=@()
foreach($w in $all){
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
"type=" + (($result).GetType().FullName)
"count=" + ($result.Count)
