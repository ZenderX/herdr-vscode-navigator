# Shell integration (optional)

This document is optional. Herdr Navigator works with no setup: it finds the live directory of the focused pane by itself (see the per-platform table in `README.md`). Read on only if the "Herdr Navigator" output channel shows `via cwd` for a pane whose directory you know has changed and the probe cannot help. The snippet is also what makes a `cd` in a Git Bash pane followed immediately: live `cd` following compares herdr's own `cwd` and never runs the probe, while focus-change following needs no setup.

## Why herdr's `cwd` can be stale

herdr's pane `cwd` is the directory the pane was spawned in. herdr documents OSC 7 as the way a shell reports its live directory, and it injects that shell integration automatically for PowerShell only. A Git Bash pane on Windows does not emit OSC 7 by default, so after `cd` herdr keeps reporting the spawn directory (for example `C:\Users\<you>\`). `foreground_cwd` may be absent, and on Windows herdr says the inspected process cwd does not reliably track a later `cd`.

The extension's own live-cwd probe (`herdrNavigator.liveCwdProbe`, with `herdrNavigator.gitBashPath` for a non-standard Git install) covers Git Bash on focus changes without this snippet. The snippet below makes herdr's own `cwd` live instead.

## Recommended snippet (verified with herdr 0.9.5 on Windows, 2026-10-17)

This variant is still optional. It emits OSC 7 only for an interactive terminal, percent-encodes `%` and spaces, and uses the Windows drive form via `cygpath -m`. Add it to `~/.bashrc` yourself.

```bash
__herdr_osc7() {
  [[ -t 1 ]] || return 0
  local p
  p="$(cygpath -m "$PWD")"
  p="${p//%/%25}"
  p="${p// /%20}"
  printf '\e]7;file:///%s\e\\' "$p"
}
case ";${PROMPT_COMMAND};" in
  *";__herdr_osc7;"*) ;;
  *) PROMPT_COMMAND="__herdr_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
```

## Other variants (unverified against herdr 0.9.5)

The two variants below have not been tested against herdr 0.9.5. OSC 7 is the only live-cwd escape herdr documents. Add one of them (not both, and not together with the recommended snippet) to `~/.bashrc` yourself. The extension never edits `~/.bashrc` and never writes under `%APPDATA%\herdr`.

Each variant adds its function to `PROMPT_COMMAND` only once, so re-sourcing `~/.bashrc` does not stack it. Spaces are percent-encoded as `%20`.

### Variant A: MSYS path (`pwd -P`)

```bash
__herdr_osc7() { printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$(pwd -P | sed 's/ /%20/g')"; }
case ";${PROMPT_COMMAND};" in
  *";__herdr_osc7;"*) ;;
  *) PROMPT_COMMAND="__herdr_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
```

Emits for example `file://HOST/c/Users/me/my%20dir`.

### Variant B: Windows path (`pwd -W`)

```bash
__herdr_osc7() { printf '\e]7;file:///%s\a' "$(pwd -W | sed 's/ /%20/g')"; }
case ";${PROMPT_COMMAND};" in
  *";__herdr_osc7;"*) ;;
  *) PROMPT_COMMAND="__herdr_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
```

Emits for example `file:///C:/Users/me/my%20dir`.

## Verify

1. Add one variant to `~/.bashrc`, then open a new Git Bash pane in herdr (an existing shell needs `source ~/.bashrc`).
2. In that pane run `cd` into a directory different from where the pane started, and press Enter once more so the prompt redraws.
3. Read herdr's view of the pane, either:
   - run `node scripts/herdr-probe.mjs` from the repository and look at the pane's `cwd` in the snapshot, or
   - open the "Herdr Navigator" output channel and read the `pane:` line after focusing the pane; its `cwd=` value should be the new directory.
4. If `cwd` changed to the directory you moved to, that variant works. If it did not change, or changed to a wrong or garbled path (for example `C:\c\Users\...` or a leading slash), swap to the other variant and repeat. If neither works, remove the snippet and rely on the probe.

To undo, delete the snippet from `~/.bashrc`.
