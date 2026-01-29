$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

if (!(Test-Path ".venv")) {
  python -m venv .venv
}

.\.venv\Scripts\python -m pip install -r requirements.txt

if (Test-Path ".env") {
  $envFile = Get-Content ".env" | Where-Object { $_ -match "=" -and $_ -notmatch "^\s*#" }
  foreach ($line in $envFile) {
    $name, $value = $line -split "=", 2
    if ($null -ne $name -and $null -ne $value) {
      $name = $name.Trim()
      $value = $value.Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      Set-Item -Path ("Env:" + $name) -Value $value
    }
  }
}

.\.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
