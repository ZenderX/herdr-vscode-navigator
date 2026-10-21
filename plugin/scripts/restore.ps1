$ErrorActionPreference = 'Stop'

$session = if ($env:HERDR_SESSION) { $env:HERDR_SESSION } else { 'default' }
$session = $session -replace '[^A-Za-z0-9_.-]', '_'

$file = Join-Path $env:HERDR_PLUGIN_STATE_DIR "focused-$session.txt"
if (-not (Test-Path -LiteralPath $file)) { exit 0 }
$label = [IO.File]::ReadAllText($file, (New-Object Text.UTF8Encoding $false))
if (-not $label) { exit 0 }

# herdr writes UTF-8; the console default is the OEM code page and mangles non-ASCII labels.
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$list = & $env:HERDR_BIN_PATH workspace list | ConvertFrom-Json
$target = $list.result.workspaces | Where-Object { $_.label -ceq $label } | Select-Object -First 1
# The space may have been closed since it was recorded.
if (-not $target) { exit 0 }

& $env:HERDR_BIN_PATH workspace focus $target.workspace_id | Out-Null
