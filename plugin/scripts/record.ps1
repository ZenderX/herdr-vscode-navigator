$ErrorActionPreference = 'Stop'

# The state dir is shared by all sessions, so the record is keyed by session name.
$session = if ($env:HERDR_SESSION) { $env:HERDR_SESSION } else { 'default' }
$session = $session -replace '[^A-Za-z0-9_.-]', '_'

# Concurrent runs can finish out of order, so record the space focused now, not the event's.
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$list = & $env:HERDR_BIN_PATH workspace list | ConvertFrom-Json
$label = ($list.result.workspaces | Where-Object { $_.focused } | Select-Object -First 1).label
if (-not $label) { exit 0 }

$file = Join-Path $env:HERDR_PLUGIN_STATE_DIR "focused-$session.txt"
[IO.File]::WriteAllText($file, $label, (New-Object Text.UTF8Encoding $false))
