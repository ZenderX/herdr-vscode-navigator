$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$herdr = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }

function Notify($title, $body) {
    # A rate-limited or failed notification must not fail the action.
    try { & $herdr notification show $title --body $body *> $null } catch { }
}

$space = $env:HERDR_WORKSPACE_ID
if (-not $space -and $env:HERDR_PLUGIN_CONTEXT_JSON) {
    $space = ($env:HERDR_PLUGIN_CONTEXT_JSON | ConvertFrom-Json).workspace_id
}
if (-not $space) {
    Notify 'No focused space' 'Focus a space in herdr, then run Open in VS Code again.'
    exit 1
}

# The session name is the directory above herdr.sock.
$session = $null
if ($env:HERDR_SOCKET_PATH -match '[\\/]sessions[\\/]([^\\/]+)[\\/]herdr\.sock$') { $session = $Matches[1] }

$uri = 'vscode://z3nder.herdr-navigator/open?space=' + [System.Uri]::EscapeDataString($space)
if ($session) { $uri += '&session=' + [System.Uri]::EscapeDataString($session) }

# VS Code started from here would inherit HERDR_* and herdr refuses nested launches keyed on HERDR_ENV.
# The variables are restored afterwards so the notification reaches the session the action ran in.
$saved = @{}
Get-ChildItem Env: | Where-Object { $_.Name -like 'HERDR_*' } | ForEach-Object { $saved[$_.Name] = $_.Value }
$saved.Keys | ForEach-Object { Remove-Item "Env:$_" }

$opened = $true
try {
    try {
        Start-Process $uri
    } catch {
        & rundll32 url.dll,FileProtocolHandler $uri
        if ($LASTEXITCODE -ne 0) { throw 'rundll32 failed' }
    }
} catch {
    $opened = $false
} finally {
    $saved.GetEnumerator() | ForEach-Object { Set-Item "Env:$($_.Key)" $_.Value }
}

if (-not $opened) {
    Notify 'Could not open VS Code' 'No URL handler was found for vscode:// links.'
    exit 1
}

Notify 'Opened in VS Code' 'You can detach this terminal with prefix+q'
