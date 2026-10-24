#!/bin/sh
# Records each pane's live folder for one herdr session until the server is gone. Started detached by cwd-return.sh; --once polls a single time without the lock.
session=
bin=
state_dir=
interval=3
once=0
while [ $# -gt 0 ]; do
  case $1 in
    --session) session=$2; shift 2 ;;
    --bin) bin=$2; shift 2 ;;
    --state-dir) state_dir=$2; shift 2 ;;
    --interval) interval=$2; shift 2 ;;
    --once) once=1; shift ;;
    *) printf 'cwd-track: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [ -z "$bin" ] || [ -z "$state_dir" ]; then
  echo 'cwd-track: --bin and --state-dir are required' >&2
  exit 2
fi

key=$(printf '%s' "${session:-default}" | tr -c 'A-Za-z0-9_.-' '_')
file="$state_dir/cwd-$key.txt"
lock="$state_dir/cwd-track-$key.pid"

herdr_cli() {
  if [ -n "$session" ]; then "$bin" --session "$session" "$@"; else "$bin" "$@"; fi
}

own_lock() {
  [ -r "$lock" ] && [ "$(cat "$lock")" = "$$" ]
}

# A detached process has no output channel, so an unexpected error lands next to the lock.
die() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "$state_dir/cwd-track-$key.err"
  [ "$once" -eq 1 ] || ! own_lock || rm -f "$lock"
  exit 1
}

# One line per pane object: "<pane_id><TAB><cwd>", JSON backslash escapes undone; a cwd with any other escape is left out.
pane_rows() {
  json=$(herdr_cli pane list 2>/dev/null) || return 1
  [ -n "$json" ] || return 1
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
      if (cwd != "") print id "\t" cwd
    }'
}

mkdir -p "$state_dir" || die "cannot create $state_dir"
record=
[ -r "$file" ] && record=$(cat "$file")
written=$record

if [ "$once" -eq 0 ]; then
  { printf '%s\n' "$$" > "$lock.tmp$$" && mv -f "$lock.tmp$$" "$lock"; } || die "cannot write $lock"
fi
failures=0
while :; do
  # A newer tracker took the lock over: leave it the record.
  [ "$once" -eq 1 ] || own_lock || exit 0
  if ! rows=$(pane_rows); then
    failures=$((failures + 1))
    # Three failed polls in a row mean the server is gone (server_not_running).
    if [ "$once" -eq 1 ] || [ "$failures" -ge 3 ]; then break; fi
    sleep "$interval"
    continue
  fi
  failures=0
  # Spawn form (trailing separator) means no prompt has reported yet: keep the live folder already recorded.
  record=$(printf '%s\n' "$rows" | REC="$record" awk -F '\t' '
    BEGIN {
      n = split(ENVIRON["REC"], lines, "\n")
      for (i = 1; i <= n; i++) {
        t = index(lines[i], "\t")
        if (t > 1) old[substr(lines[i], 1, t - 1)] = substr(lines[i], t + 1)
      }
    }
    $1 != "" {
      last = substr($2, length($2))
      if (length($2) > 3 && (last == "/" || last == "\\")) {
        if ($1 in old) print $1 "\t" old[$1]
      } else {
        print $1 "\t" $2
      }
    }')
  if [ "$record" != "$written" ]; then
    { { [ -z "$record" ] || printf '%s\n' "$record"; } > "$file.tmp$$" && mv -f "$file.tmp$$" "$file"; } || die "cannot write $file"
    written=$record
  fi
  [ "$once" -eq 0 ] || exit 0
  sleep "$interval"
done

if [ "$once" -eq 1 ]; then
  echo 'cwd-track: pane list failed' >&2
  exit 1
fi
! own_lock || rm -f "$lock"
exit 0
