# Popup body: records what the popup process sees, then stays open until popup-release appears or 40 s pass.
$out = $env:PROBE_OUT
$utf8 = New-Object Text.UTF8Encoding $false
if (-not $out) { $out = $env:HERDR_PLUGIN_STATE_DIR }

$size = try { '{0}x{1}' -f [Console]::WindowWidth, [Console]::WindowHeight } catch { 'unreadable: ' + $_.Exception.Message }
$lines = @(
  "entrypoint=$env:HERDR_PLUGIN_ENTRYPOINT_ID",
  "size=$size",
  "cwd=$((Get-Location).Path)",
  "pane_id=$(if ($env:HERDR_PANE_ID) { $env:HERDR_PANE_ID } else { '(unset)' })",
  "probe_out_set=$([bool]$env:PROBE_OUT)"
)
[IO.File]::WriteAllLines((Join-Path $out ('popup-started-{0}.txt' -f [DateTime]::UtcNow.ToString('HHmmssfff'))), $lines, $utf8)

Write-Host 'Discovery probe popup'
for ($i = 0; $i -lt 80; $i++) {
  if (Test-Path (Join-Path $out 'popup-release')) { break }
  Start-Sleep -Milliseconds 500
}
exit 0
