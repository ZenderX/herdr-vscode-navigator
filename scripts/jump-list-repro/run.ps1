param(
  [Parameter(Mandatory = $true)][string]$Scratch,
  [string]$CodeExe = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
  [string]$Bash = 'C:\Program Files\Git\bin\bash.exe',
  [switch]$Trust,
  [int]$TimeoutSec = 90
)
# Isolated jump-list repro: own user-data-dir, extensions-dir and herdr socket under $Scratch.
# Kills only the process trees it started; never touches %APPDATA%\Code or the default herdr session.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (Test-Path $Scratch) { Remove-Item -Recurse -Force $Scratch }
$ud = "$Scratch\user-data"; $ed = "$Scratch\extensions"; $probe = "$Scratch\probe"; $hh = "$Scratch\herdr"
$a = "$Scratch\project-a"; $b = "$Scratch\project-b"; $c = "$Scratch\project-c"
New-Item -ItemType Directory -Force $ud, $ed, $probe, $hh, $a, $b, $c | Out-Null

# Install the built extension and the driver as unpacked extension folders.
$ext = "$ed\z3nder.herdr-navigator-0.1.0"
New-Item -ItemType Directory -Force $ext | Out-Null
Copy-Item "$repo\package.json" $ext
Copy-Item -Recurse "$repo\out" $ext
Get-ChildItem "$ext\out\test" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Copy-Item -Recurse (Join-Path $PSScriptRoot 'driver-extension') "$ed\local.jump-list-driver-0.0.1"

# A herdr nested in the caller's pane would attach to the caller's session, so drop those variables and point at a private socket.
foreach ($name in 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_PANE_RUNTIME_ID', 'HERDR_STARTUP_CWD', 'TERM_PROGRAM') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
$env:HERDR_SOCKET_PATH = "$hh\herdr.sock"
$env:HERDR_CLIENT_SOCKET_PATH = "$hh\client.sock"
$env:HERDR_CONFIG_PATH = "$hh\config.toml"
$env:PROBE_DIR = $probe
$env:PROBE_BASH = $Bash
$env:PROBE_ANCHOR = "$ud\User\globalStorage\z3nder.herdr-navigator\anchor"

$evidence = @()
$script:cmdSeq = 0
$script:proc = $null

function Hide-Paths([string]$text) { $text.Replace($Scratch, '<scratch>').Replace($env:USERPROFILE, '<home>') }
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Start-Code([string[]]$extra) {
  $argList = @('--user-data-dir', $ud, '--extensions-dir', $ed)
  if (-not $Trust) { $argList += '--disable-workspace-trust' }
  Remove-Item "$probe\win-*.json" -ErrorAction SilentlyContinue
  $script:proc = Start-Process -FilePath $CodeExe -PassThru -ArgumentList ($argList + $extra)
}

Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class TopWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static string[] Titles(uint owner) {
    var titles = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var cls = new StringBuilder(64); GetClassName(h, cls, 64);
      var text = new StringBuilder(256); GetWindowText(h, text, 256);
      if (pid == owner && IsWindowVisible(h) && cls.ToString() == "Chrome_WidgetWin_1" && text.Length > 0) titles.Add(text.ToString());
      return true;
    }, IntPtr.Zero);
    return titles.ToArray();
  }
}
'@

# Visible VS Code windows owned by the instance this script started: the authoritative window count.
function Get-WindowTitles { @([TopWindows]::Titles([uint32]$script:proc.Id)) }

function Get-Windows {
  $now = Now-Ms
  @(Get-ChildItem $probe -Filter 'win-*.json' | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json } | Where-Object { $now - $_.t -lt 4000 })
}

function Wait-Until([scriptblock]$Condition, [string]$What, [int]$Sec = $TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($Sec)
  while ((Get-Date) -lt $deadline) {
    $value = & $Condition
    if ($value) { return $value }
    Start-Sleep -Milliseconds 500
  }
  Write-Warning "timeout waiting for: $What"
  return $null
}

function Send-Cmd([string]$name, [string]$arg = '') {
  $script:cmdSeq++
  $tmp = "$probe\tmp-$($script:cmdSeq)"
  @{ name = $name; arg = $arg } | ConvertTo-Json -Compress | Set-Content $tmp
  Move-Item $tmp "$probe\cmd-$($script:cmdSeq).json"
}

# Log lines of the newest VS Code launch, tagged with their window folder.
function Get-NavLines {
  $launch = Get-ChildItem "$ud\logs" -Directory | Sort-Object Name | Select-Object -Last 1
  if (-not $launch) { return @() }
  Get-ChildItem $launch.FullName -Recurse -Filter '*Herdr Navigator*.log' | Sort-Object FullName | ForEach-Object {
    $win = ($_.FullName -split '\\' | Where-Object { $_ -like 'window*' } | Select-Object -First 1)
    Get-Content $_.FullName | Where-Object { $_ -match 'auto-launch:|activated herdr-navigator|hosting herdr|pending:|openFolder|mutation: updateWorkspaceFolders\(' } | ForEach-Object { "$win $_" }
  }
}

function Has-Line([string]$pattern) { @(Get-NavLines | Where-Object { $_ -match $pattern }).Count -gt 0 }

function Stop-Session([string]$label) {
  Send-Cmd 'quit'
  if (-not $script:proc.WaitForExit(30000)) {
    Write-Warning "$label : quit did not exit in 30 s; killing the instance"
    cmd /c "taskkill /PID $($script:proc.Id) /T /F > nul 2>&1"
  }
  Start-Sleep -Seconds 2
}

function Snapshot([string]$label) {
  $windows = @(Get-Windows)
  $titles = Get-WindowTitles
  $script:evidence += "== $label : visible windows=$($titles.Count) extension hosts alive=$($windows.Count)"
  foreach ($t in $titles) { $script:evidence += Hide-Paths "   title=$t" }
  foreach ($w in $windows) { $script:evidence += Hide-Paths "   sessionId=$($w.sessionId) vscodePid=$($w.vscodePid) workspaceFile=$($w.workspaceFile | ConvertTo-Json -Compress) folders=$($w.folders -join ' | ')" }
  $untitled = @(Get-ChildItem "$ud\Workspaces" -ErrorAction SilentlyContinue).Count
  $script:evidence += "   user-data Workspaces entries=$untitled"
  $leaseFile = "$ud\User\globalStorage\z3nder.herdr-navigator\navigator-lease.json"
  if (Test-Path $leaseFile) { $script:evidence += "   lease launchId=$((Get-Content -Raw $leaseFile | ConvertFrom-Json).launchId)" }
  # Compare this line across snapshots: opening a second window must not rewrite the navigator file.
  $wsFile = "$ud\User\globalStorage\z3nder.herdr-navigator\anchor\navigator.code-workspace"
  if (Test-Path $wsFile) { $script:evidence += Hide-Paths "   navigator file: $((Get-Content -Raw $wsFile | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 6))" }
  foreach ($l in Get-NavLines) { $script:evidence += Hide-Paths "   $l" }
}

# Session 1, scenario E: plain folder, herdr started by hand; the window converts and reattaches. This also leaves a recorded navigator for scenario A.
Start-Code @($a)
Wait-Until { @(Get-Windows).Count -ge 1 } 'first window' | Out-Null
Start-Sleep -Seconds 5
Send-Cmd 'start-herdr' ($a -replace '\\', '/')
# The client starts the private server; give it a focused space in project-c, since a pane in the window's own folder would plan a noop and never convert.
Wait-Until { (& herdr status 2>&1 | Out-String) -match 'status: running' } 'private herdr server' 30 | Out-Null
& herdr workspace create --cwd $c --label project-c --focus | Out-Null
Wait-Until { Has-Line 'auto-launch: (create|reuse) herdr' } 'E: relaunch after conversion' | Out-Null
Start-Sleep -Seconds 8
Snapshot 'E: manual start in a plain folder'
Stop-Session 'E'

# Scenario A: launch with another folder (what the taskbar jump list does).
Start-Code @($b)
Wait-Until { Has-Line 'auto-launch: (create|reuse) herdr' } 'A: herdr after takeover' | Out-Null
Start-Sleep -Seconds 8
Snapshot 'A: folder launch after a navigator session'
Stop-Session 'A'

# Scenario B: no arguments restores the saved navigator.
Start-Code @()
Wait-Until { Has-Line 'auto-launch: (create|reuse) herdr' } 'B: herdr on restore' | Out-Null
Start-Sleep -Seconds 8
Snapshot 'B: no-argument launch'

# Scenario C: second window while the navigator runs (same session).
Send-Cmd 'new-window' $a
Wait-Until { @(Get-Windows).Count -ge 2 } 'C: second window' | Out-Null
Wait-Until { Has-Line 'navigator-alive|convert-explicit folder=.*project-a' } 'C: takeover decision of the second window' 20 | Out-Null
Start-Sleep -Seconds 5
Snapshot 'C: second folder window while the navigator runs'
Stop-Session 'C'

# Scenario D: legacy untitled workspace. The extension's own modal cannot be answered unattended, so only detection is checked.
Start-Code @($a)
# No pause: the 3 s takeover grace of the plain window must not elapse before the window becomes untitled.
Wait-Until { @(Get-Windows).Count -ge 1 } 'D: window' | Out-Null
Send-Cmd 'make-untitled'
Wait-Until { Has-Line 'auto-launch: legacy-untitled' } 'D: legacy-untitled' | Out-Null
Start-Sleep -Seconds 3
Snapshot 'D: untitled navigator workspace (modal left unanswered)'
cmd /c "taskkill /PID $($script:proc.Id) /T /F > nul 2>&1"

& herdr server stop 2>&1 | Out-Null
$evidence | Set-Content "$Scratch\evidence.txt"
$evidence
