# The discovery popup. -Answer <key> applies a key without a console and opens nothing (for tests).
param([string]$Answer)
$ErrorActionPreference = 'Stop'

$home_ = if ($env:HERDR_NAV_HOME) { $env:HERDR_NAV_HOME } else { $env:USERPROFILE }
$stateDir = if ($env:HERDR_NAV_STATE_DIR) { $env:HERDR_NAV_STATE_DIR } else { $env:HERDR_PLUGIN_STATE_DIR }
$today = if ($env:HERDR_NAV_TODAY) { $env:HERDR_NAV_TODAY } else { [DateTime]::UtcNow.ToString('yyyy-MM-dd') }
$state = Join-Path $stateDir 'discovery.state'

$interactive = -not $PSBoundParameters.ContainsKey('Answer')
if ($interactive) {
  Clear-Host
  Write-Host 'Herdr Navigator for VS Code'
  Write-Host "Makes VS Code's file tree follow your herdr space."
  Write-Host ''
  Write-Host '[i] Install   [l] Learn more   [n] Not now   [x] Never'
  $key = ''
  try {
    # Discard keys typed before the user could have read the popup.
    while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
    Start-Sleep -Seconds 1
    while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
    while ($key -eq '') {
      $pressed = [Console]::ReadKey($true)
      if ($pressed.Key -eq [ConsoleKey]::Escape) { $key = 'n' }
      elseif ("$($pressed.KeyChar)".ToLowerInvariant() -in 'i', 'l', 'n', 'x') { $key = "$($pressed.KeyChar)".ToLowerInvariant() }
    }
  } catch {
    # Input closed (popup closed or server stopped): the appearance was already counted when the popup opened.
    exit 0
  }
} else {
  $key = "$Answer".ToLowerInvariant()
  # An ignored key leaves the state untouched, as in the interactive popup.
  if ($key -notin 'i', 'l', 'n', 'x') { exit 0 }
}

$decision = if ($key -eq 'x') { 'never' } else { 'not-now' }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
# Read at answer time: discover.ps1 records the appearance after the popup starts, and that must survive the answer.
$shown = 0
$lastShown = $today
if (Test-Path -LiteralPath $state) {
  foreach ($line in [IO.File]::ReadAllLines($state)) {
    $sk, $sv = $line -split '=', 2
    if ($sk -eq 'shown') { [void][int]::TryParse($sv, [ref]$shown) }
    if ($sk -eq 'last_shown' -and $sv) { $lastShown = $sv }
  }
}
$tmp = "$state.tmp$PID"
[IO.File]::WriteAllText($tmp, "decision=$decision`nshown=$shown`nlast_shown=$lastShown`n")
Move-Item -LiteralPath $tmp -Destination $state -Force

if (-not $interactive) { exit 0 }

switch ($key) {
  'i' {
    $scheme = 'vscode'
    # Insiders is offered only when it is the only flavour found.
    if (-not (Test-Path -LiteralPath (Join-Path $home_ '.vscode')) -and (Test-Path -LiteralPath (Join-Path $home_ '.vscode-insiders'))) { $scheme = 'vscode-insiders' }
    Start-Process "${scheme}:extension/z3nder.herdr-navigator"
  }
  'l' { Start-Process 'https://marketplace.visualstudio.com/items?itemName=z3nder.herdr-navigator' }
}
exit 0
