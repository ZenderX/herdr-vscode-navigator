# Returns each idle restored pane to its recorded live folder (herdr issue #5199), then starts cwd-track.ps1. -DryRun prints the decisions instead.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$utf8 = New-Object Text.UTF8Encoding $false

$bin = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }
$session = if ($env:HERDR_SESSION) { @('--session', $env:HERDR_SESSION) } else { @() }
$key = $(if ($env:HERDR_SESSION) { $env:HERDR_SESSION } else { 'default' }) -replace '[^A-Za-z0-9_.-]', '_'
$stateDir = if ($env:HERDR_NAV_STATE_DIR) { $env:HERDR_NAV_STATE_DIR } else { $env:HERDR_PLUGIN_STATE_DIR }
$configDir = if ($env:HERDR_NAV_CONFIG_DIR) { $env:HERDR_NAV_CONFIG_DIR } else { $env:HERDR_PLUGIN_CONFIG_DIR }
$readyTimeout = if ($env:HERDR_NAV_READY_TIMEOUT) { [double]$env:HERDR_NAV_READY_TIMEOUT } else { 20 }

if (-not $stateDir) {
  Write-Output 'cwd-return: 0 panes returned, 0 skipped (no-state-dir)'
  exit 0
}
$stateDir = $stateDir.TrimEnd('\', '/')
$file = Join-Path $stateDir "cwd-$key.txt"
$lock = Join-Path $stateDir "cwd-track-$key.pid"

function Get-Panes {
  $out = & $bin @session pane list
  if ($LASTEXITCODE -ne 0) { throw "herdr pane list failed with exit code $LASTEXITCODE" }
  return ,@((($out -join "`n") | ConvertFrom-Json).result.panes)
}

# Spawn form keeps a trailing separator until the shell's first prompt reports its folder through OSC 7.
function Test-SpawnForm($cwd) {
  $cwd.Length -gt 3 -and ($cwd.EndsWith('\') -or $cwd.EndsWith('/'))
}

function Format-Folder($cwd) {
  if ($cwd.Length -gt 3) { $cwd.TrimEnd('\', '/') } else { $cwd }
}

$psRows = $null
# herdr's process-info shows only the bash launcher, idle or busy; Git's MSYS ps lists the shell's running children.
function Test-Busy($paneId) {
  $info = (((& $bin @session pane process-info --pane $paneId) -join "`n") | ConvertFrom-Json).result.process_info
  $argv0 = [string]($info.foreground_processes | Select-Object -First 1).argv0
  if (-not $argv0 -or -not $info.shell_pid) { return $false }
  $binDir = Split-Path -Parent $argv0
  $ps = @((Join-Path $binDir 'ps.exe'), (Join-Path (Split-Path -Parent $binDir) 'usr\bin\ps.exe')) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  # Not derivable: the shell was spawned by this restore moments ago, so treat it as idle.
  if (-not $ps) { return $false }
  if ($null -eq $script:psRows) {
    $script:psRows = @(& $ps -l | ForEach-Object {
      if ($_ -match '^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s') {
        [pscustomobject]@{ Pid = [int]$Matches[1]; Ppid = [int]$Matches[2]; WinPid = [int]$Matches[3] }
      }
    })
  }
  $winPids = @([int]$info.shell_pid) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$info.shell_pid)" | ForEach-Object { [int]$_.ProcessId })
  $shells = @($script:psRows | Where-Object { $winPids -contains $_.WinPid } | ForEach-Object { $_.Pid })
  if (-not $shells) { return $false }
  return [bool]($script:psRows | Where-Object { $shells -contains $_.Ppid } | Select-Object -First 1)
}

$record = [ordered]@{}
if (Test-Path -LiteralPath $file) {
  foreach ($line in [IO.File]::ReadAllLines($file, $utf8)) {
    $id, $folder = $line -split "`t", 2
    if ($id -and $folder) { $record[$id] = $folder }
  }
}

$returned = 0
$skips = [ordered]@{}
$runFailed = $false
if ($record.Count -eq 0) {
  $summary = 'cwd-return: 0 panes returned, 0 skipped (no record)'
} else {
  # Wait for the first prompt of every pane that may need a return, so the cd is not typed ahead of the shell.
  $deadline = [DateTime]::UtcNow.AddSeconds($readyTimeout)
  while ($true) {
    $panes = Get-Panes
    $waiting = @($panes | Where-Object {
      $record.Contains($_.pane_id) -and (Test-SpawnForm ([string]$_.cwd)) -and
      (Format-Folder ([string]$_.cwd)) -ne $record[$_.pane_id] -and (Test-Path -LiteralPath $record[$_.pane_id] -PathType Container)
    })
    if (-not $waiting -or [DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds 1
  }

  foreach ($id in $record.Keys) {
    $folder = $record[$id]
    $pane = $panes | Where-Object { $_.pane_id -eq $id } | Select-Object -First 1
    $cwd = if ($pane) { [string]$pane.cwd } else { '' }
    $names = if ($pane) { $pane.PSObject.Properties.Name } else { @() }
    $reason = if (-not $pane) { 'no-pane' }
      elseif ((Format-Folder $cwd) -eq $folder) { 'same' }
      elseif (-not (Test-Path -LiteralPath $folder -PathType Container)) { 'missing-folder' }
      elseif ($names -contains 'agent' -or $names -contains 'agent_session') { 'agent' }
      elseif (Test-SpawnForm $cwd) { 'not-ready' }
      elseif (Test-Busy $id) { 'busy' }
      else { '' }
    if ($reason) {
      $skips[$reason] = 1 + [int]$skips[$reason]
      if ($DryRun) { Write-Output "skip:${id}:$reason" }
      continue
    }
    if ($DryRun) {
      Write-Output "return:${id}:$folder"
      $returned++
      continue
    }
    # One argument: pane run joins several with spaces and no quoting. '\'' closes, escapes and reopens a quote.
    & $bin @session pane run $id "cd '$($folder -replace "'", "'\''")'" | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $returned++
    } else {
      $skips['run-failed'] = 1 + [int]$skips['run-failed']
      $runFailed = $true
    }
  }
  $skipped = 0
  foreach ($count in $skips.Values) { $skipped += $count }
  $summary = "cwd-return: $returned panes returned, $skipped skipped"
  if ($skipped) { $summary += ' (' + (($skips.Keys | ForEach-Object { "$_=$($skips[$_])" }) -join ', ') + ')' }
}

$notify = $false
$envFile = if ($configDir) { Join-Path $configDir '.env' } else { '' }
if ($envFile -and (Test-Path -LiteralPath $envFile)) {
  foreach ($line in [IO.File]::ReadAllLines($envFile, $utf8)) {
    $name, $value = $line.Trim("`r") -split '=', 2
    if ($name -eq 'NOTIFY_RESTORE') { $notify = $value -eq '1' }
  }
}
if ($notify -and $returned -gt 0 -and -not $DryRun) {
  # Headless servers reply no_foreground_client and toasts are rate-limited; neither should fail the return.
  $ErrorActionPreference = 'Continue'
  & $bin @session notification show 'Herdr Navigator' --body "Returned $returned panes to their last folders" --sound none *> $null
  $ErrorActionPreference = 'Stop'
}

$running = $false
if (Test-Path -LiteralPath $lock) {
  $lockPid = 0
  if ([int]::TryParse([IO.File]::ReadAllText($lock).Trim(), [ref]$lockPid)) {
    # A recycled PID belongs to some other program; only a PowerShell process can be the tracker.
    $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
    $running = $proc -and $proc.ProcessName -match '^(powershell|pwsh)$'
  }
}
if ($running) {
  if ($DryRun) { Write-Output 'skip:tracker-running' }
} elseif ($DryRun) {
  Write-Output 'start:tracker'
} else {
  $trackArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'cwd-track.ps1')`"",
    '-Bin', "`"$bin`"", '-StateDir', "`"$stateDir`"")
  if ($env:HERDR_SESSION) { $trackArgs += @('-Session', "`"$($env:HERDR_SESSION)`"") }
  if ($env:HERDR_NAV_TRACK_INTERVAL) { $trackArgs += @('-Interval', $env:HERDR_NAV_TRACK_INTERVAL) }
  # No -NoNewWindow or redirection: the tracker must not inherit the hook's pipes, which herdr waits on before the hook counts as finished.
  Start-Process -FilePath 'powershell' -WindowStyle Hidden -ArgumentList $trackArgs
}

Write-Output $summary
if ($runFailed) { exit 1 }
exit 0
