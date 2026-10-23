# Decides whether to show the Herdr Navigator discovery popup. -DryRun prints the decision instead of opening it.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

$home_ = if ($env:HERDR_NAV_HOME) { $env:HERDR_NAV_HOME } else { $env:USERPROFILE }
$stateDir = if ($env:HERDR_NAV_STATE_DIR) { $env:HERDR_NAV_STATE_DIR } else { $env:HERDR_PLUGIN_STATE_DIR }
$today = if ($env:HERDR_NAV_TODAY) { $env:HERDR_NAV_TODAY } else { [DateTime]::UtcNow.ToString('yyyy-MM-dd') }

function Finish($text) {
  Write-Output $text
  exit 0
}

if (-not $stateDir) { Finish 'skip:no-state-dir' }
$state = Join-Path $stateDir 'discovery.state'

$decision = ''
$shown = 0
$lastShown = ''
if (Test-Path -LiteralPath $state) {
  foreach ($line in [IO.File]::ReadAllLines($state)) {
    $key, $value = $line -split '=', 2
    switch ($key) {
      'decision' { $decision = $value }
      'shown' { [void][int]::TryParse($value, [ref]$shown) }
      'last_shown' { $lastShown = $value }
    }
  }
}

if ($decision -eq 'never') { Finish 'skip:never' }
if ($decision -eq 'installed') { Finish 'skip:installed' }

# A folder named for the extension counts unless VS Code marked it for removal.
function Test-ExtensionInstalled {
  $dirs = @($env:VSCODE_EXTENSIONS) + @('.vscode', '.vscode-insiders', '.vscode-oss', '.vscodium-insiders' | ForEach-Object { Join-Path (Join-Path $home_ $_) 'extensions' })
  foreach ($dir in $dirs) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
    $obsolete = Join-Path $dir '.obsolete'
    $obsoleteText = if (Test-Path -LiteralPath $obsolete) { [IO.File]::ReadAllText($obsolete) } else { '' }
    foreach ($entry in Get-ChildItem -LiteralPath $dir -Directory) {
      if ($entry.Name -notmatch '^z3nder\.herdr-navigator-\d' -or $entry.Name -like '*.vsctmp') { continue }
      if ($obsoleteText.IndexOf('"' + $entry.Name + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
      return $true
    }
  }
  return $false
}

if (Test-ExtensionInstalled) {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  [IO.File]::WriteAllText("$state.tmp$PID", "decision=installed`nshown=$shown`nlast_shown=$lastShown`n")
  Move-Item -LiteralPath "$state.tmp$PID" -Destination $state -Force
  Finish 'skip:installed'
}

if ($shown -ge 3) { Finish 'skip:limit' }

if ($lastShown) {
  $culture = [Globalization.CultureInfo]::InvariantCulture
  $age = [DateTime]::ParseExact($today, 'yyyy-MM-dd', $culture) - [DateTime]::ParseExact($lastShown, 'yyyy-MM-dd', $culture)
  if ($age.TotalDays -lt 30) { Finish 'skip:too-soon' }
}

$bin = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }
$session = if ($env:HERDR_SESSION) { @('--session', $env:HERDR_SESSION) } else { @() }

# The server's environment, not the attached client's, decides this: TERM_PROGRAM is fixed when the server starts.
if ($env:TERM_PROGRAM -ne 'vscode') {
  $folder = $env:HERDR_NAV_FOLDER
  if (-not $folder) {
    $space = $null
    if ($env:HERDR_PLUGIN_EVENT_JSON) {
      $space = ($env:HERDR_PLUGIN_EVENT_JSON | ConvertFrom-Json).data.workspace.workspace_id
    }
    if (-not $space) {
      # Startup has no event payload: take the focused space.
      $list = & $bin @session workspace list | ConvertFrom-Json
      $space = ($list.result.workspaces | Where-Object { $_.focused } | Select-Object -First 1).workspace_id
    }
    if ($space) {
      $panes = & $bin @session pane list --workspace $space | ConvertFrom-Json
      $folder = ($panes.result.panes | Select-Object -First 1).cwd
    }
  }
  if (-not $folder -or -not (Test-Path -LiteralPath $folder -PathType Container)) { Finish 'skip:no-signal' }

  $markers = (Test-Path -LiteralPath (Join-Path $folder '.vscode') -PathType Container) -or
    [bool](Get-ChildItem -LiteralPath $folder -Filter '*.code-workspace' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $markers) { Finish 'skip:no-signal' }

  $codeFound = [bool](Get-Command code -ErrorAction SilentlyContinue) -or
    (Test-Path -LiteralPath (Join-Path $home_ '.vscode')) -or
    (Test-Path -LiteralPath (Join-Path $home_ '.vscode-insiders')) -or
    ($env:LOCALAPPDATA -and (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code'))) -or
    ($env:ProgramFiles -and (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Microsoft VS Code')))
  if (-not $codeFound) { Finish 'skip:no-vscode' }
}

# A failed open leaves no appearance recorded, so a day marker keeps the probe toast to one try per day.
$toastFile = Join-Path $stateDir 'discovery.toast'
if ((Test-Path -LiteralPath $toastFile) -and ([IO.File]::ReadAllText($toastFile).Trim() -eq $today)) { Finish 'skip:toast-today' }

# A popup opened with no client attached would hold the single popup slot invisibly. HERDR_NAV_CLIENT=0|1 simulates the probe.
$attached = $true
$ErrorActionPreference = 'Continue'
if ($env:HERDR_NAV_CLIENT) {
  $attached = $env:HERDR_NAV_CLIENT -eq '1'
} elseif (-not $DryRun) {
  # notification show reports no_foreground_client only when no client is attached (it toasts when one is).
  $reply = "$(& $bin @session notification show 'Herdr Navigator' --sound none 2>$null)"
  $attached = $reply -notmatch 'no_foreground_client'
}
if (-not $attached) { Finish 'skip:no-client' }

if ($DryRun) { Finish 'show' }

$plugin = if ($env:HERDR_PLUGIN_ID) { $env:HERDR_PLUGIN_ID } else { 'zenderx.herdr-navigator' }
& $bin @session plugin pane open --plugin $plugin --entrypoint discovery-windows *> $null
if ($LASTEXITCODE -eq 0) {
  # An appearance counts once the popup is open, answered or not; a ui_busy loser never gets here.
  # The popup may already have answered: keep the decision now on disk.
  $decision = ''
  if (Test-Path -LiteralPath $state) {
    foreach ($line in [IO.File]::ReadAllLines($state)) {
      $key, $value = $line -split '=', 2
      if ($key -eq 'decision') { $decision = $value }
    }
  }
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $tmp = "$state.tmp$PID"
  [IO.File]::WriteAllText($tmp, "decision=$decision`nshown=$($shown + 1)`nlast_shown=$today`n")
  Move-Item -LiteralPath $tmp -Destination $state -Force
  Finish 'opened'
}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
[IO.File]::WriteAllText("$toastFile.tmp$PID", $today)
Move-Item -LiteralPath "$toastFile.tmp$PID" -Destination $toastFile -Force
Finish 'skip:open-failed'
