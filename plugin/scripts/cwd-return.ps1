# Returns each idle restored pane to its recorded live folder (herdr issue #5199), merging the pane list into the record before and after. -DryRun prints the decisions and writes nothing.
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
$recordScript = Join-Path $PSScriptRoot 'cwd-record.ps1'

if (-not $stateDir) {
  Write-Output 'cwd-return: 0 panes returned, 0 skipped (no-state-dir)'
  exit 0
}
$stateDir = $stateDir.TrimEnd('\', '/')
$file = Join-Path $stateDir "cwd-$key.txt"

$spawnSeen = @{}
function Get-Panes {
  $out = & $bin @session pane list
  if ($LASTEXITCODE -ne 0) { throw "herdr pane list failed with exit code $LASTEXITCODE" }
  $list = @((($out -join "`n") | ConvertFrom-Json).result.panes)
  # The spawn form is gone after the first prompt, so keep the first one each pane shows.
  foreach ($pane in $list) {
    if ((Test-SpawnForm ([string]$pane.cwd)) -and -not $script:spawnSeen.Contains($pane.pane_id)) {
      $script:spawnSeen[$pane.pane_id] = Format-Folder ([string]$pane.cwd)
    }
  }
  return ,$list
}

# Spawn form keeps a trailing separator until the shell reports its folder: PowerShell through herdr's own prompt hook at its first prompt, Git Bash only through OSC 7.
function Test-SpawnForm($cwd) {
  $cwd.Length -gt 3 -and ($cwd.EndsWith('\') -or $cwd.EndsWith('/'))
}

function Format-Folder($cwd) {
  if ($cwd.Length -gt 3) { $cwd.TrimEnd('\', '/') } else { $cwd }
}

# One trailing separator dropped, \ and / alike; -eq ignores case, as Windows paths do.
function Test-SamePath($a, $b) {
  ($a -replace '[\\/]$', '' -replace '/', '\') -eq ($b -replace '[\\/]$', '' -replace '/', '\')
}

# Skips a pane known to need no wait: its recorded spawn folder is unknown, or its spawn-form reading names another folder (herdr reused the id).
function Test-SpawnSkip($paneId) {
  -not $spawnOf[$paneId] -or ($spawnSeen.Contains($paneId) -and -not (Test-SamePath $spawnOf[$paneId] $spawnSeen[$paneId]))
}

# One process-info call per pane, shared by the spawn check and the busy check; $null when the call fails.
$infoOf = @{}
function Get-Info($paneId) {
  if (-not $script:infoOf.Contains($paneId)) {
    $out = & $bin @session pane process-info --pane $paneId
    $script:infoOf[$paneId] = if ($LASTEXITCODE -eq 0) { (($out -join "`n") | ConvertFrom-Json).result.process_info } else { $null }
  }
  $script:infoOf[$paneId]
}

# The restored pane's spawn folder: its spawn-form reading this run, else the idle shell's process cwd, which herdr restored it into. Empty when unknown.
function Get-RestoredSpawn($paneId) {
  if ($spawnSeen.Contains($paneId)) { return $spawnSeen[$paneId] }
  $info = Get-Info $paneId
  $fg = @($info.foreground_processes)
  if ($info -and $fg.Count -eq 1 -and [string]$fg[0].pid -eq [string]$info.shell_pid -and $fg[0].cwd) { return Format-Folder ([string]$fg[0].cwd) }
  ''
}

# Both spawn folders must be known and equal, or the id may now name another pane than the recorded one.
function Get-SpawnReason($paneId) {
  $restored = Get-RestoredSpawn $paneId
  if (-not $spawnOf[$paneId] -or -not $restored) { 'unknown-spawn' }
  elseif (-not (Test-SamePath $spawnOf[$paneId] $restored)) { 'mismatch' }
  else { '' }
}

# Git's MSYS ps.exe beside the pane's bash.exe (<git>\usr\bin, also for the <git>\bin launcher); '' when the shell is no Git bash or process-info failed.
function Get-GitPs($paneId) {
  $info = Get-Info $paneId
  if (-not $info -or -not $info.shell_pid) { return '' }
  # foreground_processes lists the shell only while it is idle, so its executable comes from the process; one that is gone is no Git bash.
  $argv0 = [string](Get-Process -Id ([int]$info.shell_pid) -ErrorAction SilentlyContinue).Path
  if ($argv0 -notmatch '[\\/]bash\.exe$') { return '' }
  $binDir = Split-Path -Parent $argv0
  [string](@((Join-Path $binDir 'ps.exe'), (Join-Path (Split-Path -Parent $binDir) 'usr\bin\ps.exe')) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
}

# One ps listing of every MSYS process with its Windows pid, read again after each wait step and before the decisions.
$psRows = $null
function Get-PsRows($ps) {
  if ($null -eq $script:psRows) {
    $script:psRows = @(& $ps -l | ForEach-Object {
      if ($_ -match '^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s.*\s(\S+)\s*$') {
        [pscustomobject]@{ Pid = [int]$Matches[1]; Ppid = [int]$Matches[2]; WinPid = [int]$Matches[3]; Command = $Matches[4] }
      }
    })
    if ($LASTEXITCODE -ne 0) { throw "$ps -l failed with exit code $LASTEXITCODE" }
  }
  $script:psRows
}

# The pane's MSYS bash as @{ Pid; Cygpath }, kept once found; $null while it cannot be resolved. herdr's shell_pid is that bash itself, or Git's <git>\bin\bash.exe launcher, which only starts it and waits.
$msysOf = @{}
function Get-MsysShell($paneId) {
  if ($script:msysOf.Contains($paneId)) { return $script:msysOf[$paneId] }
  $ps = Get-GitPs $paneId
  if (-not $ps) { return $null }
  $shellPid = [int](Get-Info $paneId).shell_pid
  $rows = @(Get-PsRows $ps)
  $shell = @($rows | Where-Object { $_.WinPid -eq $shellPid })
  if ($shell.Count -eq 0) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$shellPid AND Name='bash.exe'")
    if ($children.Count -ne 1) { return $null }
    $shell = @($rows | Where-Object { $_.WinPid -eq [int]$children[0].ProcessId })
  }
  # Zero or several matches leave the pane unresolved rather than risk another pane's shell.
  if ($shell.Count -ne 1 -or $shell[0].Command -notmatch '(^|/)bash(\.exe)?$') { return $null }
  $script:msysOf[$paneId] = @{ Pid = $shell[0].Pid; Cygpath = Join-Path (Split-Path -Parent $ps) 'cygpath.exe' }
  $script:msysOf[$paneId]
}

# The folder the pane's MSYS bash is in now, from /proc (it follows every cd at once); '' while the shell is unresolved or gone.
function Get-MsysCwd($paneId) {
  $shell = Get-MsysShell $paneId
  if (-not $shell) { return '' }
  $folder = & $shell.Cygpath -w "/proc/$($shell.Pid)/cwd"
  if ($LASTEXITCODE -eq 0 -and $folder) { Format-Folder ([string]$folder) } else { '' }
}

# Typed input waits in the terminal until the shell reads it, so a Git bash whose MSYS shell exists is ready before its first prompt; PowerShell is ready once herdr hears its first prompt.
function Test-Ready($pane) {
  if (Get-GitPs $pane.pane_id) { [bool](Get-MsysShell $pane.pane_id) } else { -not (Test-SpawnForm ([string]$pane.cwd)) }
}

# herdr's foreground_processes is no busy signal: it can show the bash launcher while a program runs, or the program in its place; Git's MSYS ps lists the shell's running children. A pane whose process-info failed counts as busy.
function Test-Busy($paneId) {
  if (-not (Get-Info $paneId)) { return $true }
  $shell = Get-MsysShell $paneId
  # Not derivable: the shell was spawned by this restore moments ago, so treat it as idle.
  if (-not $shell) { return $false }
  return [bool](@(Get-PsRows (Get-GitPs $paneId)) | Where-Object { $_.Ppid -eq $shell.Pid } | Select-Object -First 1)
}

# Read before the first merge, which resets the entries of reused ids.
$record = [ordered]@{}
$spawnOf = @{}
if (Test-Path -LiteralPath $file) {
  foreach ($line in [IO.File]::ReadAllLines($file, $utf8)) {
    $id, $folder, $spawn, $null = $line -split "`t", 4
    if ($id -and $folder) { $record[$id] = [string]$folder }
    if ($id -and $spawn) { $spawnOf[$id] = $spawn }
  }
}

# Restore emits no pane events, so this merge is the record's first look at the restored panes.
$panes = Get-Panes
if (-not $DryRun) { & $recordScript -Panes $panes }

$returned = [ordered]@{}
$skips = [ordered]@{}
$runFailed = $false
if ($record.Count -eq 0) {
  $summary = 'cwd-return: 0 panes returned, 0 skipped (no record)'
} else {
  # Wait until every pane that may need a return is ready, so the cd is not typed ahead of the shell.
  $deadline = [DateTime]::UtcNow.AddSeconds($readyTimeout)
  while ($true) {
    $waiting = @($panes | Where-Object {
      $record.Contains($_.pane_id) -and -not (Test-SpawnSkip $_.pane_id) -and
      (Format-Folder ([string]$_.cwd)) -ne $record[$_.pane_id] -and (Test-Path -LiteralPath $record[$_.pane_id] -PathType Container) -and
      -not (Test-Ready $_)
    })
    if (-not $waiting -or [DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds 1
    $panes = Get-Panes
    $psRows = $null
  }

  $psRows = $null
  foreach ($id in $record.Keys) {
    $folder = $record[$id]
    $pane = $panes | Where-Object { $_.pane_id -eq $id } | Select-Object -First 1
    $cwd = if ($pane) { [string]$pane.cwd } else { '' }
    $names = if ($pane) { $pane.PSObject.Properties.Name } else { @() }
    # A Git bash's herdr cwd stays the spawn folder without OSC 7, so its MSYS shell says where it is.
    $here = if ($pane -and (Get-GitPs $id)) { Get-MsysCwd $id } else { '' }
    if (-not $here) { $here = Format-Folder $cwd }
    $spawnReason = ''
    $reason = if (-not $pane) { 'no-pane' }
      elseif (Test-SamePath $here $folder) { 'same' }
      elseif ($spawnReason = Get-SpawnReason $id) { $spawnReason }
      elseif (-not (Test-Path -LiteralPath $folder -PathType Container)) { 'missing-folder' }
      elseif ($names -contains 'agent' -or $names -contains 'agent_session') { 'agent' }
      elseif (-not (Test-Ready $pane)) { 'not-ready' }
      elseif (Test-Busy $id) { 'busy' }
      else { '' }
    if ($reason) {
      $skips[$reason] = 1 + [int]$skips[$reason]
      if ($DryRun) { Write-Output "skip:${id}:$reason" }
      continue
    }
    if ($DryRun) {
      Write-Output "return:${id}:$folder"
      $returned[$id] = $folder
      continue
    }
    # One argument: pane run joins several with spaces and no quoting. '\'' closes, escapes and reopens a quote.
    & $bin @session pane run $id "cd '$($folder -replace "'", "'\''")'" | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $returned[$id] = $folder
    } else {
      $skips['run-failed'] = 1 + [int]$skips['run-failed']
      $runFailed = $true
    }
  }
  $skipped = 0
  foreach ($count in $skips.Values) { $skipped += $count }
  $summary = "cwd-return: $($returned.Count) panes returned, $skipped skipped"
  if ($skipped) { $summary += ' (' + (($skips.Keys | ForEach-Object { "$_=$($skips[$_])" }) -join ', ') + ')' }
}

if (-not $DryRun) {
  # A returned pane reaches the record once its shell is in the new folder; give each up to 10 s, then record what is there.
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ($true) {
    $panes = Get-Panes
    $pending = @($returned.Keys | Where-Object {
      $id = $_
      $pane = $panes | Where-Object { $_.pane_id -eq $id } | Select-Object -First 1
      $here = if ($pane -and (Get-GitPs $id)) { Get-MsysCwd $id } else { '' }
      if ($pane -and -not $here) { $here = Format-Folder ([string]$pane.cwd) }
      $pane -and -not (Test-SamePath $here $returned[$id])
    })
    if (-not $pending -or [DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds 1
  }
  & $recordScript -Panes $panes -Decided
}

$notify = $false
$envFile = if ($configDir) { Join-Path $configDir '.env' } else { '' }
if ($envFile -and (Test-Path -LiteralPath $envFile)) {
  foreach ($line in [IO.File]::ReadAllLines($envFile, $utf8)) {
    $name, $value = $line.Trim("`r") -split '=', 2
    if ($name -eq 'NOTIFY_RESTORE') { $notify = $value -eq '1' }
  }
}
if ($notify -and $returned.Count -gt 0 -and -not $DryRun) {
  # Headless servers reply no_foreground_client and toasts are rate-limited; neither should fail the return.
  $ErrorActionPreference = 'Continue'
  & $bin @session notification show 'Herdr Navigator' --body "Returned $($returned.Count) panes to their last folders" --sound none *> $null
  $ErrorActionPreference = 'Stop'
}

Write-Output $summary
if ($runFailed) { exit 1 }
exit 0
