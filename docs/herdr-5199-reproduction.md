# herdr #5199: reproduction facts (Windows Git Bash)

A facts-only reproduction for herdr issue #5199 (https://github.com/herdrdev/herdr/issues/5199), for the maintainer of this repo to post by hand if they choose. Nothing here has been posted. It follows herdr's `CONTRIBUTING.md`: observations only, no cause analysis, no proposed change. Every path is a placeholder: `<scratch>` is an empty scratch folder, `<session dir>` is the scratch session's `session_dir` from `herdr session list --json`.

All measurements below: 2026-10-24, on the machine described under Environment, in a scratch session `navigator-5199-probe` (never the default session), driven by a Node script calling the herdr CLI.

## Environment

- herdr 0.9.5 (`herdr --version`, 2026-10-24)
- Git for Windows 2.46.2 (`git --version` → `git version 2.46.2.windows.1`, 2026-10-24), installed at `C:\Program Files\Git`
- Windows 11 Pro, build 10.0.26300
- No OSC 7 and no terminal title from the shell: the scratch `HOME` holds a `.bashrc` with only `PS1='$ '` and `unset PROMPT_COMMAND`; `PS1`, `PROMPT_COMMAND`, `BASH_ENV`, `ENV` and every `HERDR_*` variable are removed from the server's environment, and `HERDR_CONFIG_PATH` points at the scratch config, so the user's own config and rc files are not read.

## Steps

1. Create `<scratch>\home\.bashrc`:

   ```bash
   PS1='$ '
   unset PROMPT_COMMAND
   ```

2. Create `<scratch>\config.toml`:

   ```toml
   onboarding = false

   [terminal]
   default_shell = "C:/Program Files/Git/bin/bash.exe"
   shell_mode = "non_login"
   ```

3. With `HERDR_CONFIG_PATH=<scratch>\config.toml` and `HOME=<scratch>\home` in the environment, start a scratch server and one pane:

   ```
   herdr --session navigator-5199-probe server
   herdr --session navigator-5199-probe workspace create --cwd <scratch>\spawn --focus
   ```

4. In the pane, change folder (typed, or `herdr --session navigator-5199-probe pane run <pane> "cd /c/Windows/Temp"`).
5. Read `herdr --session navigator-5199-probe pane list` and `pane process-info --pane <pane>`.
6. `herdr session stop navigator-5199-probe`, then read the pane's `cwd` in `<session dir>\session.json`.
7. Start the server again (step 3, first command only) and read `pane list` again.
8. Clean up: `herdr session stop navigator-5199-probe`, `herdr session delete navigator-5199-probe`, remove `<scratch>`.

## Observed

Measured 2026-10-24 with the herdr 0.9.5 CLI (`pane list`, `pane process-info`, `pane run`, `session stop`) and a read of `session.json` after the stop:

- After `cd /c/Windows/Temp` (step 4), `pane list` `cwd` is still `<scratch>\spawn\`.
- `pane process-info` reports `shell_pid` = the `bin\bash.exe` process and `foreground_processes[0].cwd` = `<scratch>\spawn\`, unchanged by the `cd`.
- `session.json` after the stop holds `"cwd": "<scratch>\\spawn\\"`.
- After the restart the pane is respawned in `<scratch>\spawn\`, not `C:\Windows\Temp\`.

## Expected

After the restart the pane opens in `C:\Windows\Temp\`, the folder its shell was in when the server stopped.

## Additional measurements

**Two processes, two current directories.** With `default_shell = "C:/Program Files/Git/bin/bash.exe"`, the pane's `shell_pid` is the `bin\bash.exe` process, and it has exactly one child process, `C:\Program Files\Git\bin\..\usr\bin\bash.exe` (2026-10-24, `Get-CimInstance Win32_Process -Filter "ParentProcessId=<shell_pid>"`). Each process's current directory, read from its process parameters (2026-10-24, the PowerShell helper at the end of this section), after each `cd` typed with `herdr pane run`:

| After | `bin\bash.exe` (`shell_pid`) | child `usr\bin\bash.exe` | `pane list` `cwd` |
|---|---|---|---|
| start | `<scratch>\spawn\` | `<scratch>\spawn\` | `<scratch>\spawn\` |
| `cd /c/Windows/System32` | `<scratch>\spawn\` | `C:\Windows\System32\` | `<scratch>\spawn\` |
| `cd /proc` | `<scratch>\spawn\` | `\\?\PIPE\` | `<scratch>\spawn\` |
| `cd /c/Windows/Temp` | `<scratch>\spawn\` | `C:\Windows\Temp\` | `<scratch>\spawn\` |
| after stop and restart | `<scratch>\spawn\` | `<scratch>\spawn\` | `<scratch>\spawn\` |

**With `usr\bin\bash.exe` as `default_shell`.** The issue body says the problem happens with both `bin\bash.exe` and `usr\bin\bash.exe`. On this setup, the same steps with `default_shell = "C:/Program Files/Git/usr/bin/bash.exe"` gave a different result (2026-10-24, herdr 0.9.5 CLI, `session.json` read, the PowerShell helper below):

- `shell_pid` is the `usr\bin\bash.exe` process itself, with no child process (`Get-CimInstance`, as above).
- `pane list` `cwd` and `pane process-info` `foreground_processes[0].cwd` followed every `cd`: `C:\Windows\System32\`, then `\\?\PIPE\` after `cd /proc`, then `C:\Windows\Temp\`.
- `session.json` after the stop held `"cwd": "C:\\Windows\\Temp\\"`, and the restarted pane spawned in `C:\Windows\Temp\`.

This was one pane and one restart; how Git's other tools behave in a shell started this way was not checked.

**Helper used to read a process's current directory** (PowerShell 5.1, `powershell -NoProfile -ExecutionPolicy Bypass -File pebcwd.ps1 -Pids <pid>,<pid>`; 64-bit processes only; reads `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath`):

```powershell
param([string]$Pids)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PebCwd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, byte[] info, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static byte[] Read(IntPtr h, long addr, int size) {
    var buf = new byte[size]; IntPtr n;
    if (!ReadProcessMemory(h, new IntPtr(addr), buf, size, out n)) throw new Exception("ReadProcessMemory failed: " + Marshal.GetLastWin32Error());
    return buf;
  }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      var pbi = new byte[48]; int ret;
      int st = NtQueryInformationProcess(h, 0, pbi, pbi.Length, out ret);
      if (st != 0) throw new Exception("NtQueryInformationProcess " + st);
      long peb = BitConverter.ToInt64(pbi, 8);
      long pp = BitConverter.ToInt64(Read(h, peb + 0x20, 8), 0);
      var us = Read(h, pp + 0x38, 16);
      int len = BitConverter.ToUInt16(us, 0);
      long buf = BitConverter.ToInt64(us, 8);
      return System.Text.Encoding.Unicode.GetString(Read(h, buf, len));
    } finally { CloseHandle(h); }
  }
}
'@
foreach ($p in ($Pids -split ',' | ForEach-Object { [int]$_ })) { "{0}`t{1}" -f $p, [PebCwd]::Get($p) }
```

## Comment text

What may be pasted as a comment on #5199, as is:

> Reproduced on herdr 0.9.5, Git for Windows 2.46.2, Windows 11 (build 26300), in a scratch session with a `.bashrc` that only sets `PS1='$ '` (no OSC 7, no title), `default_shell = "C:/Program Files/Git/bin/bash.exe"`, `shell_mode = "non_login"`. Measured 2026-10-24.
>
> After `cd /c/Windows/Temp` in the pane, `pane list` `cwd` and `pane process-info` `foreground_processes[0].cwd` both stay at the spawn folder, `session.json` saves the spawn folder on `herdr session stop`, and the pane comes back in the spawn folder after a restart.
>
> The pane's `shell_pid` is the `bin\bash.exe` process, which has exactly one child, `usr\bin\bash.exe`. Reading each process's current directory from its process parameters after each `cd`:
>
> | After | `bin\bash.exe` (`shell_pid`) | child `usr\bin\bash.exe` |
> |---|---|---|
> | start | `<spawn>\` | `<spawn>\` |
> | `cd /c/Windows/System32` | `<spawn>\` | `C:\Windows\System32\` |
> | `cd /proc` | `<spawn>\` | `\\?\PIPE\` |
> | `cd /c/Windows/Temp` | `<spawn>\` | `C:\Windows\Temp\` |
>
> With `default_shell = "C:/Program Files/Git/usr/bin/bash.exe"` instead (no child process), on the same machine, `pane list` `cwd` followed every `cd` (including `\\?\PIPE\` after `cd /proc`), `session.json` saved `C:\Windows\Temp\`, and the restarted pane spawned there (one pane, one restart).

## What not to include

herdr's `CONTRIBUTING.md` (master, read 2026-10-24) asks that issues carry no root-cause analysis, implementation plan, pseudocode, proposed fix or patch, and it does not accept unsolicited pull requests; feature requests go to Discussions. So keep the comment to the observations above: no reading of herdr's source, no suggestion of where or how herdr should read the shell's folder, no patch, no offer of a pull request.
