# Records each pane's live folder for one herdr session until the server is gone. Started detached by cwd-return.ps1; -Once polls a single time without the lock.
param(
  [string]$Session = '',
  [Parameter(Mandatory)][string]$Bin,
  [Parameter(Mandatory)][string]$StateDir,
  [double]$Interval = 3,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$utf8 = New-Object Text.UTF8Encoding $false

$sessionArgs = if ($Session) { @('--session', $Session) } else { @() }
$key = $(if ($Session) { $Session } else { 'default' }) -replace '[^A-Za-z0-9_.-]', '_'
$file = Join-Path $StateDir "cwd-$key.txt"
$lock = Join-Path $StateDir "cwd-track-$key.pid"

function Write-Atomic($path, $text) {
  [IO.File]::WriteAllText("$path.tmp$PID", $text, $utf8)
  Move-Item -LiteralPath "$path.tmp$PID" -Destination $path -Force
}

function Test-OwnLock {
  (Test-Path -LiteralPath $lock) -and ([IO.File]::ReadAllText($lock).Trim() -eq "$PID")
}

# A detached process has no output channel, so an unexpected error lands next to the lock.
trap {
  [IO.File]::WriteAllText((Join-Path $StateDir "cwd-track-$key.err"), "$([DateTime]::UtcNow.ToString('o')) $_`n", $utf8)
  if (-not $Once -and (Test-OwnLock)) { Remove-Item -LiteralPath $lock -Force }
  exit 1
}

function Get-Panes {
  $ErrorActionPreference = 'Continue'
  $out = & $Bin @sessionArgs pane list 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  return ,@((($out -join "`n") | ConvertFrom-Json).result.panes)
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$record = [ordered]@{}
if (Test-Path -LiteralPath $file) {
  foreach ($line in [IO.File]::ReadAllLines($file, $utf8)) {
    $id, $folder = $line -split "`t", 2
    if ($id -and $folder) { $record[$id] = $folder }
  }
}
$written = ($record.Keys | ForEach-Object { "$_`t$($record[$_])`n" }) -join ''

if (-not $Once) { Write-Atomic $lock "$PID" }
$failures = 0
while ($true) {
  # A newer tracker took the lock over: leave it the record.
  if (-not $Once -and -not (Test-OwnLock)) { exit 0 }
  $panes = Get-Panes
  if ($null -eq $panes) {
    $failures++
    # Three failed polls in a row mean the server is gone (server_not_running).
    if ($Once -or $failures -ge 3) { break }
    Start-Sleep -Milliseconds ([int]($Interval * 1000))
    continue
  }
  $failures = 0
  $next = [ordered]@{}
  foreach ($pane in $panes) {
    $cwd = [string]$pane.cwd
    # Spawn form (trailing separator) means no prompt has reported yet: keep the live folder already recorded.
    if ($cwd.Length -gt 3 -and ($cwd.EndsWith('\') -or $cwd.EndsWith('/'))) {
      if ($record.Contains($pane.pane_id)) { $next[$pane.pane_id] = $record[$pane.pane_id] }
    } elseif ($cwd) {
      $next[$pane.pane_id] = $cwd
    }
  }
  $record = $next
  $text = ($record.Keys | ForEach-Object { "$_`t$($record[$_])`n" }) -join ''
  if ($text -ne $written) {
    Write-Atomic $file $text
    $written = $text
  }
  if ($Once) { exit 0 }
  Start-Sleep -Milliseconds ([int]($Interval * 1000))
}

if ($Once) {
  [Console]::Error.WriteLine('cwd-track: pane list failed')
  exit 1
}
if (Test-OwnLock) { Remove-Item -LiteralPath $lock -Force }
exit 0
