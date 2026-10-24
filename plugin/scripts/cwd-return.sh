#!/bin/sh
# Returns each idle restored pane to its recorded live folder (herdr issue #5199), then starts cwd-track.sh. --dry-run prints the decisions instead.
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

bin=${HERDR_BIN_PATH:-herdr}
key=$(printf '%s' "${HERDR_SESSION:-default}" | tr -c 'A-Za-z0-9_.-' '_')
state_dir=${HERDR_NAV_STATE_DIR:-${HERDR_PLUGIN_STATE_DIR:-}}
config_dir=${HERDR_NAV_CONFIG_DIR:-${HERDR_PLUGIN_CONFIG_DIR:-}}
ready_timeout=${HERDR_NAV_READY_TIMEOUT:-20}
case $ready_timeout in '' | *[!0-9]*) echo "cwd-return: HERDR_NAV_READY_TIMEOUT must be whole seconds, got '$ready_timeout'" >&2; exit 1 ;; esac
tab=$(printf '\t')
cr=$(printf '\r')

if [ -z "$state_dir" ]; then
  echo 'cwd-return: 0 panes returned, 0 skipped (no-state-dir)'
  exit 0
fi
file="$state_dir/cwd-$key.txt"
lock="$state_dir/cwd-track-$key.pid"

herdr_cli() {
  if [ -n "${HERDR_SESSION:-}" ]; then "$bin" --session "$HERDR_SESSION" "$@"; else "$bin" "$@"; fi
}

# One line per pane object: "<pane_id><TAB><1 if agent><TAB><cwd>", JSON backslash escapes undone; a cwd with any other escape is left out.
pane_rows() {
  json=$(herdr_cli pane list) || return 1
  printf '%s\n' "$json" | sed 's/},{/}\
{/g' | awk '
    function unescape(v,   out, i) {
      out = ""
      while ((i = index(v, "\\")) > 0) {
        if (substr(v, i + 1, 1) != "\\") return ""
        out = out substr(v, 1, i - 1) "\\"
        v = substr(v, i + 2)
      }
      return out v
    }
    match($0, /"pane_id":"[^"]*"/) {
      id = substr($0, RSTART + 11, RLENGTH - 12)
      if (!match($0, /"cwd":"[^"]*"/)) next
      cwd = unescape(substr($0, RSTART + 7, RLENGTH - 8))
      agent = ($0 ~ /"agent(_session)?":/) ? 1 : 0
      if (cwd != "") print id "\t" agent "\t" cwd
    }'
}

# Sets agent and cwd for pane $1 from $rows; returns 1 when the pane is gone.
find_pane() {
  row=$(printf '%s\n' "$rows" | ID=$1 awk -F '\t' '$1 == ENVIRON["ID"] { print; exit }')
  [ -n "$row" ] || return 1
  rest=${row#*"$tab"}
  agent=${rest%%"$tab"*}
  cwd=${rest#*"$tab"}
}

# Spawn form keeps a trailing separator until the shell's first prompt reports its folder through OSC 7.
spawn_form() {
  [ ${#1} -gt 3 ] || return 1
  case $1 in */ | *\\) return 0 ;; esac
  return 1
}

trim_folder() {
  f=$1
  while [ ${#f} -gt 3 ]; do
    case $f in */ | *\\) f=${f%?} ;; *) break ;; esac
  done
  printf '%s' "$f"
}

# A tty foreground group other than the shell's, or a second foreground process, means a program is running. Absent fields count as idle.
pane_busy() {
  info=$(herdr_cli pane process-info --pane "$1" 2>/dev/null) || return 1
  shell_pid=$(printf '%s\n' "$info" | sed -n 's/.*"shell_pid":\([0-9][0-9]*\).*/\1/p')
  group=$(printf '%s\n' "$info" | sed -n 's/.*"foreground_process_group_id":\([0-9][0-9]*\).*/\1/p')
  count=$(printf '%s\n' "$info" | sed 's/"pid":/\
&/g' | grep -c '^"pid":')
  [ "$count" -gt 1 ] && return 0
  [ -n "$group" ] && [ -n "$shell_pid" ] && [ "$group" != "$shell_pid" ]
}

tracker_running() {
  [ -r "$lock" ] || return 1
  pid=$(cat "$lock")
  pid=${pid%"$cr"}
  case $pid in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  # A recycled PID (for example after a reboot) belongs to some other program; only a cwd-track process can be the tracker.
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\000' ' ' < "/proc/$pid/cmdline" | grep -q cwd-track
  else
    ps -p "$pid" -o args= 2>/dev/null | grep -q cwd-track
  fi
}

returned=0
skips=
run_failed=0
if [ ! -s "$file" ]; then
  summary='cwd-return: 0 panes returned, 0 skipped (no record)'
else
  # Wait for the first prompt of every pane that may need a return, so the cd is not typed ahead of the shell.
  waited=0
  while :; do
    if ! rows=$(pane_rows); then
      echo 'cwd-return: herdr pane list failed' >&2
      exit 1
    fi
    waiting=0
    while IFS="$tab" read -r id folder <&3 || [ -n "$id" ]; do
      folder=${folder%"$cr"}
      [ -n "$id" ] && [ -n "$folder" ] || continue
      find_pane "$id" || continue
      spawn_form "$cwd" || continue
      [ "$(trim_folder "$cwd")" != "$folder" ] || continue
      [ -d "$folder" ] || continue
      waiting=1
      break
    done 3< "$file"
    [ "$waiting" -eq 1 ] && [ "$waited" -lt "$ready_timeout" ] || break
    sleep 1
    waited=$((waited + 1))
  done

  while IFS="$tab" read -r id folder <&3 || [ -n "$id" ]; do
    folder=${folder%"$cr"}
    [ -n "$id" ] && [ -n "$folder" ] || continue
    reason=
    if ! find_pane "$id"; then reason=no-pane
    elif [ "$(trim_folder "$cwd")" = "$folder" ]; then reason=same
    elif [ ! -d "$folder" ]; then reason=missing-folder
    elif [ "$agent" = 1 ]; then reason=agent
    elif spawn_form "$cwd"; then reason=not-ready
    elif pane_busy "$id"; then reason=busy
    fi
    if [ -n "$reason" ]; then
      skips="$skips$reason
"
      [ "$dry_run" -eq 0 ] || printf 'skip:%s:%s\n' "$id" "$reason"
      continue
    fi
    if [ "$dry_run" -eq 1 ]; then
      printf 'return:%s:%s\n' "$id" "$folder"
      returned=$((returned + 1))
      continue
    fi
    # One argument: pane run joins several with spaces and no quoting. '\'' closes, escapes and reopens a quote.
    quoted=$(printf '%s' "$folder" | sed "s/'/'\\\\''/g")
    if herdr_cli pane run "$id" "cd '$quoted'" > /dev/null; then
      returned=$((returned + 1))
    else
      skips="${skips}run-failed
"
      run_failed=1
    fi
  done 3< "$file"
  summary=$(printf '%s' "$skips" | awk -v returned="$returned" '
    !($1 in count) { order[++n] = $1 }
    { count[$1]++; total++ }
    END {
      line = "cwd-return: " returned " panes returned, " (total + 0) " skipped"
      for (i = 1; i <= n; i++) list = list (i > 1 ? ", " : "") order[i] "=" count[order[i]]
      if (n) line = line " (" list ")"
      print line
    }')
fi

notify=0
if [ -n "$config_dir" ] && [ -r "$config_dir/.env" ]; then
  while IFS='=' read -r name value || [ -n "$name" ]; do
    [ "$name" = NOTIFY_RESTORE ] || continue
    notify=0
    [ "${value%"$cr"}" = 1 ] && notify=1
  done < "$config_dir/.env"
fi
if [ "$notify" -eq 1 ] && [ "$returned" -gt 0 ] && [ "$dry_run" -eq 0 ]; then
  # Headless servers reply no_foreground_client and toasts are rate-limited; neither should fail the return.
  herdr_cli notification show 'Herdr Navigator' --body "Returned $returned panes to their last folders" --sound none > /dev/null 2>&1 || :
fi

if tracker_running; then
  [ "$dry_run" -eq 0 ] || echo 'skip:tracker-running'
elif [ "$dry_run" -eq 1 ]; then
  echo 'start:tracker'
else
  set -- "$(dirname "$0")/cwd-track.sh" --bin "$bin" --state-dir "$state_dir"
  [ -z "${HERDR_SESSION:-}" ] || set -- "$@" --session "$HERDR_SESSION"
  [ -z "${HERDR_NAV_TRACK_INTERVAL:-}" ] || set -- "$@" --interval "$HERDR_NAV_TRACK_INTERVAL"
  detach=
  command -v setsid > /dev/null 2>&1 && detach=setsid
  # No inherited stdio: herdr waits on the hook's pipes before the hook counts as finished.
  $detach nohup sh "$@" < /dev/null > /dev/null 2>&1 &
fi

echo "$summary"
[ "$run_failed" -eq 0 ] || exit 1
exit 0
