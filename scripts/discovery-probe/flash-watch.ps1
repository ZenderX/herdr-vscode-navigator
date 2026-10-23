param(
  [int]$Seconds = 15,
  [Parameter(Mandatory = $true)][string]$Out
)

# Polls visible top-level windows every ~15 ms and records each window handle first seen after the baseline.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinSnap {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Snapshot() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        uint pid; GetWindowThreadProcessId(h, out pid);
        list.Add(h.ToInt64() + "|" + sb + "|" + pid);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$seen = @{}
foreach ($w in [WinSnap]::Snapshot()) { $seen[$w.Split('|')[0]] = $true }
$found = @()
Write-Output 'ready'
$end = [DateTime]::UtcNow.AddSeconds($Seconds)
$polls = 0
while ([DateTime]::UtcNow -lt $end) {
  $polls++
  foreach ($w in [WinSnap]::Snapshot()) {
    $p = $w.Split('|')
    if ($seen.ContainsKey($p[0])) { continue }
    $seen[$p[0]] = $true
    $name = (Get-Process -Id ([int]$p[2]) -ErrorAction SilentlyContinue).ProcessName
    $found += [pscustomobject]@{ class = $p[1]; process = $name; at = [DateTime]::UtcNow.ToString('HH:mm:ss.fff') }
  }
  Start-Sleep -Milliseconds 15
}
$result = [pscustomobject]@{ polls = $polls; newWindows = $found }
[IO.File]::WriteAllText($Out, ($result | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
