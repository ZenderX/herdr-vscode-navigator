#!/bin/sh
# Returns each idle restored pane to its recorded live folder (herdr issue #5199), merging the pane list into the record before and after. --dry-run prints the decisions and writes nothing.
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

bin=${HERDR_BIN_PATH:-herdr}
key=$(printf '%s' "${HERDR_SESSION:-default}" | tr -c 'A-Za-z0-9_.-' '_')
state_dir=${HERDR_NAV_STATE_DIR:-${HERDR_PLUGIN_STATE_DIR:-}}
config_dir=${HERDR_NAV_CONFIG_DIR:-${HERDR_PLUGIN_CONFIG_DIR:-}}
ready_timeout=${HERDR_NAV_READY_TIMEOUT:-20}
case $ready_timeout in '' | *[!0-9]*) echo "cwd-return: HERDR_NAV_READY_TIMEOUT must be whole seconds, got '$ready_timeout'" >&2; exit 1 ;; esac
record_script="$(dirname "$0")/cwd-record.sh"
tab=$(printf '\t')
cr=$(printf '\r')

if [ -z "$state_dir" ]; then
  echo 'cwd-return: 0 panes returned, 0 skipped (no-state-dir)'
  exit 0
fi
file="$state_dir/cwd-$key.txt"

herdr_cli() {
  if [ -n "${HERDR_SESSION:-}" ]; then "$bin" --session "$HERDR_SESSION" "$@"; else "$bin" "$@"; fi
}

# The herdr server's pid and start time name this server run; cwd-record runs as this script's child, so it gets them as HERDR_NAV_INSTANCE.
if [ -z "${HERDR_NAV_INSTANCE:-}" ]; then
  if [ -r "/proc/$PPID/stat" ]; then
    start=$(sed 's/.*) //' "/proc/$PPID/stat" | awk '{ print $20 }')
  else
    start=$(ps -o lstart= -p "$PPID" | tr -s ' ' '_')
  fi
  [ -n "$start" ] || { echo "cwd-return: cannot read the start time of process $PPID" >&2; exit 1; }
  HERDR_NAV_INSTANCE="$PPID:$start"
fi
export HERDR_NAV_INSTANCE

# Sets json and rows, one row per pane object: "<pane_id><TAB><1 if agent><TAB><cwd>", JSON backslash escapes undone; a cwd with any other escape is left out.
list_panes() {
  if ! json=$(herdr_cli pane list); then
    echo 'cwd-return: herdr pane list failed' >&2
    exit 1
  fi
  rows=$(printf '%s\n' "$json" | sed 's/},{/}\
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
    }')
  # The spawn form is gone after the first prompt, so keep the first one each pane shows: "<pane_id><TAB><folder>".
  spawn_seen=$(printf '%s\n' "$rows" | SEEN="$spawn_seen" awk -F '\t' '
    BEGIN {
      n = split(ENVIRON["SEEN"], lines, "\n")
      for (i = 1; i <= n; i++) {
        if (lines[i] == "") continue
        print lines[i]
        seen[substr(lines[i], 1, index(lines[i], "\t") - 1)] = 1
      }
    }
    $1 != "" && !($1 in seen) && length($3) > 3 && $3 ~ /[\/\\]$/ {
      f = $3
      while (length(f) > 3 && f ~ /[\/\\]$/) f = substr(f, 1, length(f) - 1)
      print $1 "\t" f
      seen[$1] = 1
    }')
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

# One trailing separator dropped, \ and / alike; Windows folders (any \) compare case-insensitively.
same_path() {
  a=$1
  b=$2
  case $a in */ | *\\) a=${a%?} ;; esac
  case $b in */ | *\\) b=${b%?} ;; esac
  case $1$2 in
    *\\*) a=$(printf '%s' "$a" | tr 'A-Z\\' 'a-z/'); b=$(printf '%s' "$b" | tr 'A-Z\\' 'a-z/') ;;
  esac
  [ "$a" = "$b" ]
}

seen_spawn() {
  printf '%s\n' "$spawn_seen" | ID=$1 awk -F '\t' '$1 == ENVIRON["ID"] { print $2; exit }'
}

# Pane $1 recorded with spawn folder $2 needs no wait: the spawn folder is unknown, or its spawn-form reading names another folder (herdr reused the id).
spawn_skip() {
  [ -n "$2" ] || return 0
  seen=$(seen_spawn "$1")
  [ -n "$seen" ] && ! same_path "$2" "$seen"
}

# Sets info for pane $1, one process-info call per pane, shared by the spawn check and the busy check; returns 1 when the call fails.
info_id=
info_ok=1
load_info() {
  if [ "$info_id" != "$1" ]; then
    info_id=$1
    info_ok=0
    info=$(herdr_cli pane process-info --pane "$1" 2>/dev/null) || info_ok=1
  fi
  return "$info_ok"
}

# Sets restored to pane $1's spawn folder: its spawn-form reading this run, else the idle shell's process cwd, which herdr restored it into; empty when unknown.
restored_spawn() {
  restored=$(seen_spawn "$1")
  [ -z "$restored" ] || return 0
  load_info "$1" || return 0
  shell_pid=$(printf '%s\n' "$info" | sed -n 's/.*"shell_pid":\([0-9][0-9]*\).*/\1/p')
  restored=$(printf '%s\n' "$info" | SHELL_PID=$shell_pid awk '
    function unescape(v,   out, i) {
      out = ""
      while ((i = index(v, "\\")) > 0) {
        if (substr(v, i + 1, 1) != "\\") return ""
        out = out substr(v, 1, i - 1) "\\"
        v = substr(v, i + 2)
      }
      return out v
    }
    {
      n = 0
      rest = $0
      while (match(rest, /"pid":[0-9]+/)) {
        n++
        pid = substr(rest, RSTART + 6, RLENGTH - 6)
        rest = substr(rest, RSTART + RLENGTH)
      }
      if (n != 1 || pid != ENVIRON["SHELL_PID"] || !match($0, /"cwd":"[^"]*"/)) exit
      print unescape(substr($0, RSTART + 7, RLENGTH - 8))
    }')
  restored=$(trim_folder "$restored")
}

# Sets reason for pane $1 recorded with spawn folder $2: both spawn folders must be known and equal, or the id may now name another pane than the recorded one.
spawn_reason() {
  restored_spawn "$1"
  if [ -z "$2" ] || [ -z "$restored" ]; then reason=unknown-spawn
  elif ! same_path "$2" "$restored"; then reason=mismatch
  else return 1
  fi
}

# Splits a record line "<id><TAB><live folder>[<TAB><spawn folder>[<TAB><shell pid>]]" into id, folder and spawn; the live folder may be empty.
split_line() {
  line=${1%"$cr"}
  id=${line%%"$tab"*}
  rest=${line#*"$tab"}
  folder=${rest%%"$tab"*}
  spawn=
  [ "$folder" = "$rest" ] || spawn=${rest#*"$tab"}
  spawn=${spawn%%"$tab"*}
  [ "$rest" != "$line" ] || id=
}

# A tty foreground group other than the shell's, or a second foreground process, means a program is running. Absent fields count as idle; a failed process-info counts as busy.
pane_busy() {
  load_info "$1" || return 0
  shell_pid=$(printf '%s\n' "$info" | sed -n 's/.*"shell_pid":\([0-9][0-9]*\).*/\1/p')
  group=$(printf '%s\n' "$info" | sed -n 's/.*"foreground_process_group_id":\([0-9][0-9]*\).*/\1/p')
  count=$(printf '%s\n' "$info" | sed 's/"pid":/\
&/g' | grep -c '^"pid":')
  [ "$count" -gt 1 ] && return 0
  [ -n "$group" ] && [ -n "$shell_pid" ] && [ "$group" != "$shell_pid" ]
}

# Read before the first merge, which resets the entries of reused ids.
record=
[ -r "$file" ] && record=$(cat "$file")

spawn_seen=
list_panes
# Restore emits no pane events, so this merge is the record's first look at the restored panes.
if [ "$dry_run" -eq 0 ]; then
  printf '%s\n' "$json" | sh "$record_script" --stdin || exit 1
fi

returned=0
returned_list=
skips=
run_failed=0
if [ -z "$record" ]; then
  summary='cwd-return: 0 panes returned, 0 skipped (no record)'
else
  # Wait for the first prompt of every pane that may need a return, so the cd is not typed ahead of the shell.
  waited=0
  while :; do
    waiting=0
    while IFS= read -r line <&3; do
      split_line "$line"
      [ -n "$id" ] && [ -n "$folder" ] || continue
      find_pane "$id" || continue
      spawn_form "$cwd" || continue
      ! spawn_skip "$id" "$spawn" || continue
      [ "$(trim_folder "$cwd")" != "$folder" ] || continue
      [ -d "$folder" ] || continue
      waiting=1
      break
    done 3<<EOF
$record
EOF
    [ "$waiting" -eq 1 ] && [ "$waited" -lt "$ready_timeout" ] || break
    sleep 1
    waited=$((waited + 1))
    list_panes
  done

  while IFS= read -r line <&3; do
    split_line "$line"
    [ -n "$id" ] && [ -n "$folder" ] || continue
    reason=
    if ! find_pane "$id"; then reason=no-pane
    elif [ "$(trim_folder "$cwd")" = "$folder" ]; then reason=same
    elif spawn_reason "$id" "$spawn"; then :
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
      returned_list="$returned_list$id$tab$folder
"
    else
      skips="${skips}run-failed
"
      run_failed=1
    fi
  done 3<<EOF
$record
EOF
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

if [ "$dry_run" -eq 0 ]; then
  # A returned pane reaches the record once its shell reports the new folder; give each up to 10 s, then record what is there.
  waited=0
  while :; do
    list_panes
    pending=0
    while IFS= read -r line <&3; do
      split_line "$line"
      [ -n "$id" ] || continue
      find_pane "$id" || continue
      [ "$(trim_folder "$cwd")" = "$folder" ] && continue
      pending=1
      break
    done 3<<EOF
$returned_list
EOF
    [ "$pending" -eq 1 ] && [ "$waited" -lt 10 ] || break
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s\n' "$json" | sh "$record_script" --stdin --decided || exit 1
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

echo "$summary"
[ "$run_failed" -eq 0 ] || exit 1
exit 0
