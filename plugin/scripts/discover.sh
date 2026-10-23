#!/bin/sh
# Decides whether to show the Herdr Navigator discovery popup. --dry-run prints the decision instead of opening it.
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

home=${HERDR_NAV_HOME:-$HOME}
state_dir=${HERDR_NAV_STATE_DIR:-${HERDR_PLUGIN_STATE_DIR:-}}
state="$state_dir/discovery.state"
today=${HERDR_NAV_TODAY:-$(date -u +%Y-%m-%d)}

finish() {
  printf '%s\n' "$1"
  exit 0
}

[ -n "$state_dir" ] || finish "skip:no-state-dir"

decision=
shown=0
last_shown=
if [ -r "$state" ]; then
  while IFS='=' read -r key value; do
    value=${value%"$(printf '\r')"}
    case $key in
      decision) decision=$value ;;
      shown) shown=$value ;;
      last_shown) last_shown=$value ;;
    esac
  done < "$state"
fi
case $shown in '' | *[!0-9]*) shown=0 ;; esac

[ "$decision" = never ] && finish "skip:never"
[ "$decision" = installed ] && finish "skip:installed"

# A folder named for the extension counts unless VS Code marked it for removal.
extension_installed() {
  for dir in "${VSCODE_EXTENSIONS:-}" "$home/.vscode/extensions" "$home/.vscode-insiders/extensions" "$home/.vscode-oss/extensions" "$home/.vscodium-insiders/extensions"; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    for entry in "$dir"/*; do
      name=${entry##*/}
      case $name in
        *.vsctmp) continue ;;
        [Zz]3nder.[Hh]erdr-[Nn]avigator-[0-9]*) ;;
        *) continue ;;
      esac
      [ -d "$entry" ] || continue
      grep -qiF "\"$name\"" "$dir/.obsolete" 2>/dev/null && continue
      return 0
    done
  done
  return 1
}

if extension_installed; then
  mkdir -p "$state_dir" && printf 'decision=installed\nshown=%s\nlast_shown=%s\n' "$shown" "$last_shown" > "$state.tmp$$" && mv "$state.tmp$$" "$state"
  finish "skip:installed"
fi

[ "$shown" -lt 3 ] || finish "skip:limit"

# Days since 1970-01-01 for YYYY-MM-DD (civil-calendar arithmetic, no date(1) flags that differ per platform).
day_number() {
  y=${1%%-*}
  rest=${1#*-}
  m=${rest%%-*}
  d=${rest#*-}
  m=${m#0}
  d=${d#0}
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400))
  yoe=$((y - era * 400))
  if [ "$m" -gt 2 ]; then mp=$((m - 3)); else mp=$((m + 9)); fi
  doy=$(((153 * mp + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe - 719468))
}

if [ -n "$last_shown" ]; then
  [ $(($(day_number "$today") - $(day_number "$last_shown"))) -ge 30 ] || finish "skip:too-soon"
fi

# The server's environment, not the attached client's, decides this: TERM_PROGRAM is fixed when the server starts.
if [ "${TERM_PROGRAM:-}" != vscode ]; then
  herdr_bin=${HERDR_BIN_PATH:-herdr}
  set --
  [ -z "${HERDR_SESSION:-}" ] || set -- --session "$HERDR_SESSION"
  folder=${HERDR_NAV_FOLDER:-}
  if [ -z "$folder" ]; then
    space=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | sed -n 's/.*"workspace_id" *: *"\([^"]*\)".*/\1/p')
    if [ -z "$space" ]; then
      # Startup has no event payload: take the focused space.
      space=$("$herdr_bin" "$@" workspace list 2>/dev/null | sed 's/{"active_tab_id"/\
&/g' | awk '/"focused":true/ && match($0, /"workspace_id":"[^"]*"/) { print substr($0, RSTART + 16, RLENGTH - 17); exit }')
    fi
    [ -z "$space" ] || folder=$("$herdr_bin" "$@" pane list --workspace "$space" 2>/dev/null | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
  fi
  [ -n "$folder" ] || finish "skip:no-signal"

  has_markers=0
  [ -d "$folder/.vscode" ] && has_markers=1
  for f in "$folder"/*.code-workspace; do
    [ -e "$f" ] && has_markers=1
  done
  [ "$has_markers" -eq 1 ] || finish "skip:no-signal"

  code_found=0
  command -v code >/dev/null 2>&1 && code_found=1
  for p in "$home/.vscode" "$home/.vscode-insiders" "/Applications/Visual Studio Code.app" /usr/share/code; do
    [ -e "$p" ] && code_found=1
  done
  [ "$code_found" -eq 1 ] || finish "skip:no-vscode"
fi

herdr_bin=${HERDR_BIN_PATH:-herdr}
set --
[ -z "${HERDR_SESSION:-}" ] || set -- --session "$HERDR_SESSION"

# A popup opened with no client attached would hold the single popup slot invisibly. HERDR_NAV_CLIENT=0|1 simulates the probe.
client_attached() {
  if [ -n "${HERDR_NAV_CLIENT:-}" ]; then
    [ "$HERDR_NAV_CLIENT" = 1 ]
    return
  fi
  # A dry run must not flash a toast.
  [ "$dry_run" -eq 0 ] || return 0
  # notification show reports no_foreground_client only when no client is attached (it toasts when one is).
  reply=$("$herdr_bin" "$@" notification show "Herdr Navigator" --sound none 2>/dev/null)
  case $reply in *no_foreground_client*) return 1 ;; esac
  return 0
}
# A failed open leaves no appearance recorded, so a day marker keeps the probe toast to one try per day.
toast_file="$state_dir/discovery.toast"
toast_day=
[ -r "$toast_file" ] && IFS= read -r toast_day < "$toast_file"
[ "${toast_day%"$(printf '\r')"}" != "$today" ] || finish "skip:toast-today"

client_attached || finish "skip:no-client"

[ "$dry_run" -eq 0 ] || finish "show"

if "$herdr_bin" "$@" plugin pane open --plugin "${HERDR_PLUGIN_ID:-zenderx.herdr-navigator}" --entrypoint discovery >/dev/null 2>&1; then
  # An appearance counts once the popup is open, answered or not; a ui_busy loser never gets here.
  # The popup may already have answered: keep the decision now on disk.
  decision=
  if [ -r "$state" ]; then
    while IFS='=' read -r key value; do
      [ "$key" = decision ] && decision=${value%"$(printf '\r')"}
    done < "$state"
  fi
  mkdir -p "$state_dir" && printf 'decision=%s\nshown=%s\nlast_shown=%s\n' "$decision" $((shown + 1)) "$today" > "$state.tmp$$" && mv "$state.tmp$$" "$state"
  finish "opened"
fi
mkdir -p "$state_dir" && printf '%s\n' "$today" > "$toast_file.tmp$$" && mv "$toast_file.tmp$$" "$toast_file"
finish "skip:open-failed"
