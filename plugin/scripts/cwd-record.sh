#!/bin/sh
# Merges one herdr pane list into the session's return record (herdr issue #5199). Runs as an event hook, and from cwd-return.sh, which pipes in the list it already read (--stdin); --decided flags cwd-return's final merge, after its decisions.
bin=${HERDR_BIN_PATH:-herdr}
key=$(printf '%s' "${HERDR_SESSION:-default}" | tr -c 'A-Za-z0-9_.-' '_')
state_dir=${HERDR_NAV_STATE_DIR:-${HERDR_PLUGIN_STATE_DIR:-}}
if [ -z "$state_dir" ]; then
  echo 'cwd-record: no plugin state dir' >&2
  exit 1
fi
file="$state_dir/cwd-$key.txt"
instance_file="$state_dir/cwd-$key.instance"
lock="$file.lock"
rerun="$file.rerun"
tab=$(printf '\t')
nl='
'
stdin=0
decided=0
rerun_run=0
for arg in "$@"; do
  case $arg in
    --stdin) stdin=1 ;;
    --decided) decided=1 ;;
    --rerun) rerun_run=1 ;;
    *) echo "cwd-record: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done
mkdir -p "$state_dir" || { echo "cwd-record: cannot create $state_dir" >&2; exit 1; }

herdr_cli() {
  if [ -n "${HERDR_SESSION:-}" ]; then "$bin" --session "$HERDR_SESSION" "$@"; else "$bin" "$@"; fi
}

# Hooks and startup commands are children of the herdr server, so its pid and start time name the server run; cwd-return passes its own as HERDR_NAV_INSTANCE.
server_instance() {
  if [ -r "/proc/$PPID/stat" ]; then
    start=$(sed 's/.*) //' "/proc/$PPID/stat" | awk '{ print $20 }')
  else
    start=$(ps -o lstart= -p "$PPID" | tr -s ' ' '_')
  fi
  [ -n "$start" ] || { echo "cwd-record: cannot read the start time of process $PPID" >&2; exit 1; }
  printf '%s:%s' "$PPID" "$start"
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

# Sets shell_pid and shell_spawn for pane $1 from herdr pane process-info, shell_spawn empty unless the idle shell itself is the foreground; returns 1 when the call fails.
shell_info() {
  shell_pid=
  shell_spawn=
  if ! info=$(herdr_cli pane process-info --pane "$1"); then
    echo "cwd-record: herdr pane process-info --pane $1 failed" >&2
    return 1
  fi
  shell_pid=$(printf '%s\n' "$info" | sed -n 's/.*"shell_pid":\([0-9][0-9]*\).*/\1/p')
  shell_spawn=$(printf '%s\n' "$info" | SHELL_PID=$shell_pid awk '
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
  shell_spawn=$(trim_folder "$shell_spawn")
}

instance=${HERDR_NAV_INSTANCE:-}
if [ -z "$instance" ]; then instance=$(server_instance) || exit 1; fi

# Hooks overlap: one merge at a time, each listing panes inside the lock.
tries=0
until mkdir "$lock" 2>/dev/null; do
  # Whoever took the lock after this run's parent released it removes the request when its merge starts, after every request the parent saw.
  [ "$rerun_run" -eq 0 ] || exit 0
  # A hook that finds the lock held leaves a rerun request: the holder merges again after its write, so a merge that starts after this hook covers it. cwd-return (--stdin) waits instead: its --decided merge stamps the server run, which a holder's rerun would not.
  if [ "$stdin" -eq 0 ]; then
    if [ "$tries" -eq 0 ]; then
      : > "$rerun" || { echo "cwd-record: cannot write $rerun" >&2; exit 1; }
    elif [ ! -e "$rerun" ]; then
      # Removed by a holder whose merge started after the request: this hook is covered.
      exit 0
    fi
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 100 ]; then
    # A merge takes well under a second, so a lock held for 10 s belongs to a killed hook.
    rmdir "$lock" 2>/dev/null
    mkdir "$lock" || { echo "cwd-record: cannot take $lock" >&2; exit 1; }
    break
  fi
  sleep 0.1
done
trap 'rmdir "$lock"' EXIT
trap 'exit 1' HUP INT TERM
# Removed before the pane list is read: every request left from here on gets a merge that starts after it.
rm -f "$rerun"

if [ "$stdin" -eq 1 ]; then
  json=$(cat)
else
  json=$(herdr_cli pane list) || { echo 'cwd-record: herdr pane list failed' >&2; exit 1; }
fi

# One line per pane object: "<pane_id><TAB><cwd>", JSON backslash escapes undone; a cwd with any other escape is left out.
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
    if (cwd != "") print id "\t" cwd
  }')

# One line per pane: "<id><TAB><live folder><TAB><spawn folder><TAB><shell pid>"; any column after the id may be empty. Older lines have two or three columns.
old=
[ -r "$file" ] && old=$(cat "$file")

# A record written in another server run waits for that run's cwd-return: until it has decided, no entry may learn a spawn folder or pid from a restored pane.
on_disk=
[ -r "$instance_file" ] && on_disk=$(cat "$instance_file")
pending=0
[ "$decided" -eq 0 ] && [ -n "$old" ] && [ "$on_disk" != "$instance" ] && pending=1

text=
while IFS= read -r row <&3; do
  id=${row%%"$tab"*}
  cwd=${row#*"$tab"}
  [ -n "$id" ] && [ -n "$cwd" ] && [ "$cwd" != "$row" ] || continue
  line=$(printf '%s\n' "$old" | ID=$id awk -F '\t' '{ sub(/\r$/, "") } NF >= 2 && $1 == ENVIRON["ID"] { print; exit }')
  if [ "$pending" -eq 1 ] && [ -n "$line" ]; then
    text="$text$line$nl"
    continue
  fi
  live=
  spawn=
  pid=
  if [ -n "$line" ]; then
    rest=${line#*"$tab"}
    live=${rest%%"$tab"*}
    if [ "$rest" != "$live" ]; then
      rest=${rest#*"$tab"}
      spawn=${rest%%"$tab"*}
      [ "$rest" = "$spawn" ] || pid=${rest#*"$tab"}
    fi
  fi
  seen=
  moved=0
  # Spawn form (trailing separator) means no prompt has reported yet; the reading is the folder the pane was spawned in.
  if [ ${#cwd} -gt 3 ] && case $cwd in */ | *\\) true ;; *) false ;; esac; then
    seen=$(trim_folder "$cwd")
    # Another spawn folder under a known id means herdr reused the id for a different pane.
    if [ -n "$spawn" ] && ! same_path "$spawn" "$seen"; then live=; fi
  else
    [ "$cwd" = "$live" ] || moved=1
    live=$cwd
  fi
  # herdr persists the shell's process cwd, so the spawn folder is read again whenever the live folder moves.
  if [ "$decided" -eq 1 ] || [ -z "$pid" ] || [ -z "$spawn" ] || [ -n "$seen" ] || [ "$moved" -eq 1 ]; then
    if shell_info "$id"; then known=1; else known=0; fi
    if [ "$decided" -eq 1 ]; then
      # cwd-return has decided: the restored shell's pid and spawn folder replace the pre-restart ones.
      spawn=${seen:-$shell_spawn}
      pid=$shell_pid
    elif [ "$known" -eq 1 ] && [ -n "$pid" ] && [ "$shell_pid" != "$pid" ]; then
      # Another shell under the id in this server run: herdr reused the id, so nothing of the old pane applies.
      [ -z "$seen" ] || live=
      spawn=${seen:-$shell_spawn}
      pid=$shell_pid
    elif [ "$known" -eq 1 ]; then
      spawn=${seen:-${shell_spawn:-$spawn}}
      pid=$shell_pid
    elif [ -n "$seen" ]; then
      spawn=$seen
    fi
  fi
  text="$text$id$tab$live$tab$spawn$tab$pid$nl"
done 3<<EOF
$rows
EOF
record=${text%"$nl"}

# Written whole and renamed into place: cwd-return reads the record without the lock.
if [ "$record" != "$old" ]; then
  { { [ -z "$record" ] || printf '%s\n' "$record"; } > "$file.tmp$$" && mv -f "$file.tmp$$" "$file"; } || {
    echo "cwd-record: cannot write $file" >&2
    rm -f "$file.tmp$$"
    exit 1
  }
fi
if [ "$pending" -eq 0 ] && [ "$on_disk" != "$instance" ]; then
  printf '%s' "$instance" > "$instance_file" || { echo "cwd-record: cannot write $instance_file" >&2; exit 1; }
fi
if [ -e "$rerun" ]; then
  # A hook asked for a merge while this one ran: run again as that hook would, with a fresh pane list.
  trap - EXIT
  rmdir "$lock" || { echo "cwd-record: cannot release $lock" >&2; exit 1; }
  exec sh "$0" --rerun
fi
exit 0
