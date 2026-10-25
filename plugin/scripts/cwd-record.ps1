# Merges one herdr pane list into the session's return record (herdr issue #5199). Runs as an event hook, and from cwd-return.ps1 with the list it already read; -Decided flags cwd-return's final merge, after its decisions.
param([object[]]$Panes, [switch]$Decided)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$utf8 = New-Object Text.UTF8Encoding $false

$bin = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }
$session = if ($env:HERDR_SESSION) { @('--session', $env:HERDR_SESSION) } else { @() }
$key = $(if ($env:HERDR_SESSION) { $env:HERDR_SESSION } else { 'default' }) -replace '[^A-Za-z0-9_.-]', '_'
$stateDir = if ($env:HERDR_NAV_STATE_DIR) { $env:HERDR_NAV_STATE_DIR } else { $env:HERDR_PLUGIN_STATE_DIR }
if (-not $stateDir) { throw 'cwd-record: no plugin state dir' }
$stateDir = $stateDir.TrimEnd('\', '/')
$file = Join-Path $stateDir "cwd-$key.txt"
$instanceFile = Join-Path $stateDir "cwd-$key.instance"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

# Spawn form keeps a trailing separator until the shell's first prompt reports its folder.
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

# Hooks and startup commands are children of the herdr server, so its pid and start time name the server run.
function Get-Instance {
  $parent = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
  "${parent}:$([Diagnostics.Process]::GetProcessById($parent).StartTime.ToUniversalTime().Ticks)"
}

# Git's MSYS ps.exe lists every MSYS process with its Windows pid; one listing per Git install and merge.
$psRowsOf = @{}
function Get-MsysRows($argv0) {
  $binDir = Split-Path -Parent $argv0
  $ps = @((Join-Path $binDir 'ps.exe'), (Join-Path (Split-Path -Parent $binDir) 'usr\bin\ps.exe')) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $ps) { return @() }
  if (-not $script:psRowsOf.Contains($ps)) {
    $rows = @(& $ps -l | ForEach-Object {
      if ($_ -match '^\s*[A-Z]?\s*(\d+)\s+\d+\s+\d+\s+(\d+)\s.*\s(\S+)\s*$') {
        [pscustomobject]@{ Pid = $Matches[1]; WinPid = $Matches[2]; Command = $Matches[3]; Dir = Split-Path -Parent $ps }
      }
    })
    if ($LASTEXITCODE -ne 0) { throw "cwd-record: $ps -l failed with exit code $LASTEXITCODE" }
    $script:psRowsOf[$ps] = $rows
  }
  $script:psRowsOf[$ps]
}

# The Windows pids of the bash.exe children of a process. One CIM query per merge lists them all: it costs ~300 ms, so one per new pane would grow with a burst.
$bashChildren = $null
function Get-BashChildren($parentPid) {
  if ($null -eq $script:bashChildren) {
    $script:bashChildren = @{}
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='bash.exe'")) {
      $parent = [string]$process.ParentProcessId
      if (-not $script:bashChildren.Contains($parent)) { $script:bashChildren[$parent] = @() }
      $script:bashChildren[$parent] += [string]$process.ProcessId
    }
  }
  if ($script:bashChildren.Contains([string]$parentPid)) { $script:bashChildren[[string]$parentPid] } else { @() }
}

# Returns @{ Pid; Msys; Spawn; Live } from herdr pane process-info; $null when the call fails. Pid is the shell's own Windows pid, Msys herdr's shell_pid when that shell is an MSYS bash (else empty), Spawn empty unless the idle shell itself is the foreground, Live the MSYS shell's current folder from /proc (else empty).
function Get-ShellInfo($paneId, $entry) {
  $out = & $bin @session pane process-info --pane $paneId
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("cwd-record: herdr pane process-info --pane $paneId failed with exit code $LASTEXITCODE")
    return $null
  }
  $info = (($out -join "`n") | ConvertFrom-Json).result.process_info
  $shellPid = [string]$info.shell_pid
  $fg = @($info.foreground_processes)
  $spawn = if ($fg.Count -eq 1 -and [string]$fg[0].pid -eq $shellPid -and $fg[0].cwd) { Format-Folder ([string]$fg[0].cwd) } else { '' }
  $result = @{ Pid = $shellPid; Msys = ''; Spawn = $spawn; Live = '' }
  if (-not $shellPid) { return $result }
  # foreground_processes lists the shell only while it is idle, so its executable comes from the process; one that is gone has no live reading.
  $argv0 = [string](Get-Process -Id ([int]$shellPid) -ErrorAction SilentlyContinue).Path
  if ($argv0 -notmatch '[\\/]bash\.exe$') { return $result }
  $rows = @(Get-MsysRows $argv0)
  # herdr may run <git>\usr\bin\bash.exe itself, with no launcher in between.
  $shell = @($rows | Where-Object { $_.WinPid -eq $shellPid })
  if ($shell.Count -eq 0) {
    # Git for Windows' <git>\bin\bash.exe only starts <git>\usr\bin\bash.exe and waits, so the shell is that one child, fixed for the launcher's life.
    if ($argv0 -notmatch '[\\/]bin[\\/]bash\.exe$' -or -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent (Split-Path -Parent $argv0)) 'usr\bin\bash.exe') -PathType Leaf)) { return $result }
    $inner = if ($entry.Msys -eq $shellPid -and $entry.Pid) { $entry.Pid } else {
      $children = @(Get-BashChildren $shellPid)
      if ($children.Count -eq 1) { $children[0] } else { '' }
    }
    if (-not $inner) { return $result }
    $result.Pid = $inner
    $result.Msys = $shellPid
    $shell = @($rows | Where-Object { $_.WinPid -eq $inner })
  } else {
    $result.Msys = $shellPid
  }
  # Zero or several matches leave the pane without a live reading rather than risk another pane's folder.
  if ($shell.Count -ne 1 -or $shell[0].Command -notmatch '(^|/)bash(\.exe)?$') { return $result }
  # One pid per call: a pid that vanished aborts a call that names several.
  $folder = & (Join-Path $shell[0].Dir 'cygpath.exe') -w "/proc/$($shell[0].Pid)/cwd"
  if ($LASTEXITCODE -eq 0 -and $folder) { $result.Live = Format-Folder ([string]$folder) }
  $result
}

# One fork-free bash run reads the current folder of every given MSYS pid; returns @{ <msys pid> = <folder> }, a vanished pid left out.
function Read-MsysCwds($dir, $msysPids) {
  # cd -P keeps pid and folder paired inside the loop and hands cygpath resolved folders: a vanished pid aborts a cygpath of several /proc links.
  $loop = 'P=(); D=(); for p; do cd -P "/proc/$p/cwd" 2>/dev/null || continue; P+=("$p"); D+=("$PWD"); done; [ ${#P[@]} -gt 0 ] || exit 0; printf ''%s\n'' "${P[@]}"; exec /usr/bin/cygpath -w "${D[@]}"'
  # Windows PowerShell 5.1 passes embedded quotes to native commands unescaped.
  $out = @(& (Join-Path $dir 'bash.exe') -c ($loop -replace '"', '\"') _ @msysPids)
  if ($LASTEXITCODE -ne 0) { throw "cwd-record: reading the MSYS shells' folders failed with exit code $LASTEXITCODE" }
  if ($out.Count % 2) { throw "cwd-record: the MSYS shells' pids and folders do not pair up: $($out -join ' | ')" }
  $folders = @{}
  $half = $out.Count / 2
  for ($i = 0; $i -lt $half; $i++) { $folders[[string]$out[$i]] = Format-Folder ([string]$out[$half + $i]) }
  $folders
}

# A recorded MSYS shell that is still alive under its recorded launcher needs no process-info: returns @{ <pane id> = <live folder> } for those panes; a pane left out takes the full lookup.
function Get-MemoLive($ids, $record) {
  $known = @($ids | Where-Object { $record.Contains($_) -and $record[$_].Msys -and $record[$_].Pid -and $record[$_].Spawn })
  $live = @{}
  if (-not $known) { return $live }
  $launchers = @{}
  foreach ($id in $known) { $launchers[$record[$id].Msys] = $true }
  $exeOf = @{}
  # One process snapshot for all launchers: Get-Process -Id takes a snapshot per pid, ~8 ms each. A launcher that is gone is the stale-memo signal, not an error.
  foreach ($process in [Diagnostics.Process]::GetProcesses()) {
    if ($launchers.Contains([string]$process.Id)) { $exeOf[[string]$process.Id] = [string]$process.Path }
  }
  $shellOf = @{}
  foreach ($id in $known) {
    $exe = $exeOf[$record[$id].Msys]
    if ($exe -notmatch '[\\/]bash\.exe$') { continue }
    $shell = @(Get-MsysRows $exe | Where-Object { $_.WinPid -eq $record[$id].Pid })
    if ($shell.Count -eq 1 -and $shell[0].Command -match '(^|/)bash(\.exe)?$') { $shellOf[$id] = $shell[0] }
  }
  foreach ($group in @($shellOf.GetEnumerator() | Group-Object { $_.Value.Dir })) {
    $folders = Read-MsysCwds $group.Name @($group.Group | ForEach-Object { $_.Value.Pid })
    foreach ($pair in $group.Group) { $live[$pair.Key] = [string]$folders[$pair.Value.Pid] }
  }
  $live
}

function Invoke-Merge($Panes, [bool]$Decided) {
  # A rerun must see the shells that exist now.
  $script:psRowsOf = @{}
  $script:bashChildren = $null
  if ($null -eq $Panes) {
    $out = & $bin @session pane list
    if ($LASTEXITCODE -ne 0) { throw "cwd-record: herdr pane list failed with exit code $LASTEXITCODE" }
    $Panes = @((($out -join "`n") | ConvertFrom-Json).result.panes)
  }

  # One line per pane: "<id><TAB><live folder><TAB><spawn folder><TAB><shell pid><TAB><msys>", msys being herdr's shell_pid when the shell is an MSYS bash; any column after the id may be empty. Older lines have two to four columns.
  $old = if (Test-Path -LiteralPath $file) { [IO.File]::ReadAllText($file, $utf8) } else { '' }
  $record = @{}
  foreach ($line in $old -split "`n") {
    $line = $line.TrimEnd("`r")
    $id, $live, $spawn, $shellPid, $msys = $line -split "`t", 5
    if ($id -and ($live -or $spawn -or $shellPid)) { $record[$id] = @{ Line = $line; Live = [string]$live; Spawn = [string]$spawn; Pid = [string]$shellPid; Msys = [string]$msys } }
  }

  # A record written in another server run waits for that run's cwd-return: until it has decided, no entry may learn a spawn folder or pid from a restored pane.
  $onDisk = if (Test-Path -LiteralPath $instanceFile) { [IO.File]::ReadAllText($instanceFile, $utf8) } else { '' }
  $pending = -not $Decided -and $record.Count -gt 0 -and $onDisk -cne $instance
  $memoLive = if ($Decided -or $pending) { @{} } else { Get-MemoLive @($Panes | ForEach-Object { [string]$_.pane_id }) $record }

  $text = ''
  foreach ($pane in $Panes) {
    $id = [string]$pane.pane_id
    $cwd = [string]$pane.cwd
    if (-not $id -or -not $cwd) { continue }
    if ($pending -and $record.Contains($id)) {
      $text += "$($record[$id].Line)`n"
      continue
    }
    $entry = if ($record.Contains($id)) { $record[$id] } else { @{ Live = ''; Spawn = ''; Pid = ''; Msys = '' } }
    $live = $entry.Live
    $spawn = $entry.Spawn
    $shellPid = $entry.Pid
    $msys = $entry.Msys
    $seen = ''
    $moved = $false
    if (Test-SpawnForm $cwd) {
      $seen = Format-Folder $cwd
      # Another spawn folder under a known id means herdr reused the id for a different pane.
      if ($spawn -and -not (Test-SamePath $spawn $seen)) { $live = '' }
    } else {
      $moved = $cwd -cne $live
      $live = $cwd
    }
    if ($memoLive.Contains($id) -and -not $moved -and (-not $seen -or (Test-SamePath $spawn $seen))) {
      # Git Bash's herdr cwd moves only on OSC 7; its MSYS shell's /proc cwd follows every cd at once.
      if ($memoLive[$id]) { $live = $memoLive[$id] }
    } elseif ($Decided -or $msys -or -not $shellPid -or -not $spawn -or $seen -or $moved) {
      # herdr persists the shell's process cwd, so the spawn folder is read again whenever the live folder moves; an MSYS shell whose memo is stale is looked up afresh, and so is a restored pane, whose pre-restart entry names another server run's processes.
      $shell = Get-ShellInfo $id $(if ($Decided) { @{} } else { $entry })
      if ($Decided) {
        # cwd-return has decided: the restored shell's pid and spawn folder replace the pre-restart ones.
        $spawn = if ($seen) { $seen } elseif ($shell) { $shell.Spawn } else { '' }
        $shellPid = if ($shell) { $shell.Pid } else { '' }
        $msys = if ($shell) { $shell.Msys } else { '' }
      } elseif ($shell -and $shellPid -and $shell.Pid -ne $shellPid) {
        # Another shell under the id in this server run: herdr reused the id, so nothing of the old pane applies.
        if ($seen) { $live = '' }
        $spawn = if ($seen) { $seen } else { $shell.Spawn }
        $shellPid = $shell.Pid
        $msys = $shell.Msys
      } elseif ($shell) {
        $spawn = if ($seen) { $seen } elseif ($shell.Spawn) { $shell.Spawn } else { $spawn }
        $shellPid = $shell.Pid
        $msys = $shell.Msys
      } elseif ($seen) {
        $spawn = $seen
      }
      if ($shell -and $shell.Live) { $live = $shell.Live }
    }
    $text += "$id`t$live`t$spawn`t$shellPid`t$msys`n"
  }

  # Written whole and renamed into place: cwd-return reads the record without the lock.
  if ($text -cne $old) {
    $tmp = "$file.tmp$PID"
    [IO.File]::WriteAllText($tmp, $text, $utf8)
    for ($try = 1; ; $try++) {
      try {
        if ([IO.File]::Exists($file)) { [IO.File]::Replace($tmp, $file, [NullString]::Value) } else { [IO.File]::Move($tmp, $file) }
        break
      } catch [IO.IOException], [UnauthorizedAccessException] {
        # A reader can hold the file open for a moment on Windows.
        if ($try -ge 20) { Remove-Item -LiteralPath $tmp -Force; throw }
        Start-Sleep -Milliseconds 50
      }
    }
  }
  if (-not $pending -and $onDisk -cne $instance) { [IO.File]::WriteAllText($instanceFile, $instance, $utf8) }
}

function Open-Lock {
  try { [IO.File]::Open("$file.lock", 'OpenOrCreate', 'ReadWrite', 'None') } catch [IO.IOException] { $null }
}

$instance = Get-Instance
# Hooks overlap: one merge at a time, each listing panes inside the lock. The OS drops the lock with its process.
$lock = Open-Lock
# A hook that finds the lock held leaves a rerun request: the holder merges again after its write, so a merge that starts after this hook covers it.
$rerun = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, "Local\herdr-navigator-rerun-$($file -replace '\\', '/')")
try {
  # cwd-return (-Panes) waits for the lock instead: its -Decided merge stamps the server run, which a holder's rerun would not.
  if (-not $lock -and -not $PSBoundParameters.ContainsKey('Panes')) { [void]$rerun.Set() }
  for ($try = 1; -not $lock; $try++) {
    # Reset by a holder whose merge started after the request: this hook is covered.
    if (-not $PSBoundParameters.ContainsKey('Panes') -and -not $rerun.WaitOne(0)) { exit 0 }
    if ($try -ge 200) { throw "cwd-record: $file.lock stayed locked for 10 s" }
    Start-Sleep -Milliseconds 50
    $lock = Open-Lock
  }
  try {
    # Assigned, not taken from an if expression, which would unroll a one-pane list.
    $list = $null
    if ($PSBoundParameters.ContainsKey('Panes')) { $list = $Panes }
    $first = $true
    do {
      [void]$rerun.Reset()
      Invoke-Merge $list ($first -and $Decided)
      $list = $null
      $first = $false
    } while ($rerun.WaitOne(0))
  } finally {
    $lock.Dispose()
  }
} finally {
  $rerun.Dispose()
}
