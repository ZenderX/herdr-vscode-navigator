#!/bin/sh
# The discovery popup. --answer <key> applies a key without a terminal and opens nothing (for tests).
home=${HERDR_NAV_HOME:-$HOME}
state_dir=${HERDR_NAV_STATE_DIR:-${HERDR_PLUGIN_STATE_DIR:-}}
state="$state_dir/discovery.state"
today=${HERDR_NAV_TODAY:-$(date -u +%Y-%m-%d)}

# Read at answer time: discover.sh records the appearance after the popup starts, and that must survive the answer.
read_state() {
  shown=0
  last_shown=
  if [ -r "$state" ]; then
    while IFS='=' read -r skey svalue; do
      svalue=${svalue%"$(printf '\r')"}
      case $skey in
        shown) shown=$svalue ;;
        last_shown) last_shown=$svalue ;;
      esac
    done < "$state"
  fi
  [ -n "$last_shown" ] || last_shown=$today
  case $shown in '' | *[!0-9]*) shown=0 ;; esac
}

if [ "${1:-}" = "--answer" ]; then
  key=$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')
  interactive=0
else
  interactive=1
  printf '\033[2J\033[H'
  printf 'Herdr Navigator for VS Code\n'
  printf "Makes VS Code's file tree follow your herdr space.\n\n"
  printf '[i] Install   [l] Learn more   [n] Not now   [x] Never\n'
  saved=$(stty -g 2>/dev/null)
  restore_tty() { [ -z "$saved" ] || stty "$saved" 2>/dev/null; }
  trap 'restore_tty; exit 130' INT TERM HUP
  stty raw -echo 2>/dev/null
  # Discard keys typed before the user could have read the popup.
  sleep 1
  stty min 0 time 0 2>/dev/null
  dd bs=1024 count=1 >/dev/null 2>&1
  stty min 1 time 0 2>/dev/null
  key=
  while [ -z "$key" ]; do
    # The trailing x survives command substitution, so a bare "x" means no byte was read.
    k=$(dd bs=1 count=1 2>/dev/null && printf x)
    if [ "$k" = x ] || [ -z "$k" ]; then
      # Closed pty (popup closed or server stopped): the appearance was already counted when the popup opened.
      restore_tty
      trap - INT TERM HUP
      exit 0
    fi
    k=${k%x}
    case $k in
      i | I) key=i ;;
      l | L) key=l ;;
      n | N) key=n ;;
      x | X) key=x ;;
      "$(printf '\033')")
        # Arrow and function keys send ESC plus more bytes: only a bare ESC means Not now.
        stty min 0 time 1 2>/dev/null
        more=$(dd bs=1024 count=1 2>/dev/null && printf x)
        stty min 1 time 0 2>/dev/null
        [ "$more" = x ] && key=n
        ;;
    esac
  done
  restore_tty
  trap - INT TERM HUP
fi

case $key in
  i | l | n | x) ;;
  *) exit 0 ;;
esac
if [ "$key" = x ]; then decision=never; else decision=not-now; fi
read_state
[ -n "$state_dir" ] && mkdir -p "$state_dir" &&
  printf 'decision=%s\nshown=%s\nlast_shown=%s\n' "$decision" "$shown" "$last_shown" > "$state.tmp$$" &&
  mv "$state.tmp$$" "$state"

[ "$interactive" -eq 1 ] || exit 0

open_url() {
  if [ "$(uname)" = Darwin ]; then
    open "$1"
  else
    xdg-open "$1"
  fi
}

case $key in
  i)
    scheme=vscode
    # Insiders is offered only when it is the only flavour found.
    if [ ! -d "$home/.vscode" ] && [ -d "$home/.vscode-insiders" ]; then scheme=vscode-insiders; fi
    open_url "$scheme:extension/z3nder.herdr-navigator" >/dev/null 2>&1
    ;;
  l) open_url "https://marketplace.visualstudio.com/items?itemName=z3nder.herdr-navigator" >/dev/null 2>&1 ;;
esac
exit 0
