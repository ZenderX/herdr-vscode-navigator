# A linked plugin is global, so ignore every session except the probe's.
if ($env:HERDR_SESSION -ne 'navigator-discovery-probe') { exit 0 }
$out = $env:PROBE_OUT
if (-not $out) { exit 0 }

$utf8 = New-Object Text.UTF8Encoding $false
$event = $env:HERDR_PLUGIN_EVENT
$tag = '{0}-{1}' -f $event, [DateTime]::UtcNow.ToString('HHmmssfff')

$names = 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_INJECTION', 'HERDR_SESSION', 'HERDR_PLUGIN_EVENT',
  'HERDR_PLUGIN_ID', 'HERDR_PLUGIN_ROOT', 'HERDR_PLUGIN_STATE_DIR', 'HERDR_PLUGIN_EVENT_JSON', 'HERDR_SOCKET_PATH'
$lines = foreach ($n in $names) {
  $v = [Environment]::GetEnvironmentVariable($n)
  '{0}={1}' -f $n, $(if ($null -eq $v) { '(unset)' } else { $v })
}
$lines += 'CWD=' + (Get-Location).Path
[IO.File]::WriteAllLines((Join-Path $out "env-$tag.txt"), $lines, $utf8)

# arm-<event>.txt holds "<entrypoint> <cli|manifest>": cli passes --placement popup --width 60 --height 8, manifest relies on the pane entry.
$arm = Join-Path $out "arm-$event.txt"
if (-not (Test-Path $arm)) { exit 0 }
$entry, $mode = ([IO.File]::ReadAllText($arm).Trim() -split ' ')

$cliArgs = @('--session', $env:HERDR_SESSION, 'plugin', 'pane', 'open', '--plugin', $env:HERDR_PLUGIN_ID, '--entrypoint', $entry)
if ($mode -eq 'cli') { $cliArgs += @('--placement', 'popup', '--width', '60', '--height', '8') }

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = $utf8
$text = (& $env:HERDR_BIN_PATH @cliArgs 2>&1 | Out-String)
$code = $LASTEXITCODE
$log = @("command=herdr $($cliArgs -join ' ')", "exit=$code", "output=$text")
[IO.File]::WriteAllLines((Join-Path $out "popup-$tag.log"), $log, $utf8)
exit 0
