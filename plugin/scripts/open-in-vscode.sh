#!/bin/sh
herdr_bin=${HERDR_BIN_PATH:-herdr}

notify() {
  # A rate-limited or failed notification must not fail the action.
  "$herdr_bin" notification show "$1" --body "$2" >/dev/null 2>&1 || true
}

space=${HERDR_WORKSPACE_ID:-}
if [ -z "$space" ]; then
  space=$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | sed -n 's/.*"workspace_id" *: *"\([^"]*\)".*/\1/p')
fi
if [ -z "$space" ]; then
  notify "No focused space" "Focus a space in herdr, then run Open in VS Code again."
  exit 1
fi

# The session name is the directory above herdr.sock.
session=$(printf '%s' "${HERDR_SOCKET_PATH:-}" | sed -n 's|.*/sessions/\([^/]*\)/herdr\.sock$|\1|p')

encode() {
  for h in $(printf '%s' "$1" | LC_ALL=C od -An -v -tx1); do
    case $h in
      2[de] | 5f | 7e | 3[0-9] | 4[1-9a-f] | 5[0-9a] | 6[1-9a-f] | 7[0-9a])
        printf "\\$(printf '%03o' "0x$h")" ;;
      *) printf '%%%s' "$(printf '%s' "$h" | tr 'a-f' 'A-F')" ;;
    esac
  done
}

uri="vscode://z3nder.herdr-navigator/open?space=$(encode "$space")"
[ -z "$session" ] || uri="$uri&session=$(encode "$session")"

# VS Code started from here would inherit HERDR_* and herdr refuses nested launches keyed on HERDR_ENV.
launch() (
  for name in $(env | sed -n 's/^\(HERDR_[A-Za-z0-9_]*\)=.*/\1/p'); do
    unset "$name"
  done
  if [ "$(uname)" = Darwin ]; then
    open "$uri"
  elif command -v xdg-open >/dev/null 2>&1 && xdg-open "$uri"; then
    :
  elif command -v gio >/dev/null 2>&1 && gio open "$uri"; then
    :
  elif command -v code >/dev/null 2>&1; then
    code --open-url "$uri"
  else
    exit 127
  fi
)

launch >/dev/null 2>&1
status=$?
if [ "$status" -eq 127 ]; then
  notify "Could not open VS Code" "No URL handler was found (xdg-open, gio or code)."
  exit 1
elif [ "$status" -ne 0 ]; then
  notify "Could not open VS Code" "The URL opener failed."
  exit 1
fi

notify "Opened in VS Code" "You can detach this terminal with prefix+q"
