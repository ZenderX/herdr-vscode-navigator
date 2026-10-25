#!/bin/sh
# Runs inside the container started by run.sh: the plugin's sh cwd-record / cwd-return pair against a headless herdr server
# in the scratch session navigator-linux-probe, with the repository mounted read-only at /repo. Prints one row per check.
set -u
SESSION=navigator-linux-probe
PLUGIN_ID=zenderx.herdr-navigator
repo=${PROBE_REPO:-/repo}
state=${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/$PLUGIN_ID
record=$state/cwd-$SESSION.txt
instance_file=$state/cwd-$SESSION.instance
scratch=$(mktemp -d /tmp/navigator-linux.XXXXXX)
spawn="$scratch/demo app@v1"
sub="$spawn/sub dir"
other="$scratch/other folder"
wrong="$scratch/wrong spawn"
mkdir -p "$sub" "$other" "$wrong"
tab=$(printf '\t')
rows=
step=setup

row() { rows="$rows$1$tab$2$tab$3
"; }
fail() {
  row "$step" FAIL "$1"
  exit 1
}
report() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ -r "$record" ]; then
    echo '--- record'
    cat "$record"
    echo '--- plugin log'
    herdr --session "$SESSION" plugin log list --plugin "$PLUGIN_ID" --limit 500 2> /dev/null | jq -c '.result.logs[]? | {command: .command[1], event, status, stdout, stderr}'
  fi
  herdr session stop "$SESSION" > /dev/null 2>&1
  herdr session stop navigator-linux-shell > /dev/null 2>&1
  printf '%s' "$rows" | awk -F '\t' '{ printf "%-18s %-5s %s\n", $1, $2, $3 }'
  [ "$rc" -eq 0 ] && echo "probe: passed in $(( $(date +%s) - began )) s" || echo "probe: FAILED at step '$step'"
}
began=$(date +%s)
trap report EXIT
trap 'exit 1' HUP INT TERM

h() { herdr --session "$SESSION" "$@"; }
now_ms() { date +%s%3N; }
running() { herdr session list --json | jq -e --arg s "$1" '.sessions[] | select(.name == $s and .running)' > /dev/null; }
# Waits up to $2 tenths of a second for command $1 (a shell string) to succeed.
wait_for() {
  n=0
  until eval "$1"; do
    n=$((n + 1))
    [ "$n" -lt "$2" ] || return 1
    sleep 0.1
  done
}
start_server() {
  ( cd "$scratch" && env "$@" herdr --session "$SESSION" server > "$scratch/server.log" 2>&1 & )
  wait_for "running $SESSION" 100 || fail 'server did not start'
}
stop_server() {
  herdr session stop "$SESSION" > /dev/null || fail 'session stop failed'
  wait_for "! running $SESSION" 150 || fail 'server did not stop'
}
pane_cwd() { h pane list | jq -r --arg id "$1" '.result.panes[] | select(.pane_id == $id) | .cwd'; }
info_cwd() { h pane process-info --pane "$1" | jq -r '.result.process_info | .shell_pid as $s | .foreground_processes[] | select(.pid == $s) | .cwd'; }
info_pid() { h pane process-info --pane "$1" | jq -r '.result.process_info.shell_pid'; }
line_of() { awk -F '\t' -v id="$1" '$1 == id { print; exit }' "$record"; }
col() { line_of "$1" | awk -F '\t' -v n="$2" '{ print $n }'; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
cwd_is() { [ "$(pane_cwd "$1")" = "$2" ]; }
col_is() { [ "$(col "$1" "$2")" = "$3" ]; }
logs() { h plugin log list --plugin "$PLUGIN_ID" --limit 500 | jq -c --arg s "$1" --argjson since "$2" '[.result.logs[] | select((.command | join(" ")) | contains($s)) | select((.finished_unix_ms // 9e15) >= $since)]'; }
hooks_settled() { [ "$(logs cwd-record "$1" | jq '[.[] | select(.status == "running" or .status == null)] | length')" = 0 ]; }
return_done() { [ "$(logs cwd-return "$1" | jq -r '.[0].status // "running"')" != running ]; }
# Sets hooks to how many cwd-record hooks ran since $1, failing unless all finished and succeeded.
hooks_ok() {
  wait_for "hooks_settled $1" 200 || fail 'cwd-record hooks did not finish'
  failed=$(logs cwd-record "$1" | jq -c '[.[] | select(.status != "succeeded")][0] // empty')
  [ -z "$failed" ] || fail "cwd-record hook failed: $failed"
  hooks=$(logs cwd-record "$1" | jq length)
}
# Sets ret to "<status><TAB><stdout><TAB><stderr>" of the first cwd-return run since $1.
return_log() {
  wait_for "return_done $1" 450 || fail 'no finished cwd-return log entry'
  ret=$(logs cwd-return "$1" | jq -r '.[0] | "\(.status)\t\(.stdout | rtrimstr("\n"))\t\(.stderr)"')
}
# Shell commands typed into a pane: herdr pane run sends one line and Enter.
type_in() { h pane run "$1" "$2" > /dev/null || fail "pane run $1 failed"; }
# Sets pid to the $$ of pane $1's shell, as the shell itself reports it.
shell_pid_of() {
  rm -f "$scratch/pid"
  type_in "$1" "echo \$\$ > $(quote "$scratch/pid")"
  wait_for "[ -s $(quote "$scratch/pid") ]" 50 || fail "pane $1 did not report its pid"
  pid=$(cat "$scratch/pid")
}

step=default-shell
herdr session list --json | jq -e --arg s "$SESSION" '.sessions[] | select(.name == $s)' > /dev/null && fail "session $SESSION already exists"
[ ! -e "$state" ] || fail "plugin state dir $state already exists"
# The shell herdr picks with no config.toml and no SHELL, before the plugin is linked so no hook runs.
[ ! -e "$HOME/.config/herdr/config.toml" ] || fail 'a herdr config.toml exists'
( cd "$scratch" && env -u SHELL herdr --session navigator-linux-shell server > /dev/null 2>&1 & )
wait_for 'running navigator-linux-shell' 100 || fail 'shell-check server did not start'
probe_pane=$(herdr --session navigator-linux-shell workspace create --cwd "$scratch" | jq -r .result.root_pane.pane_id)
default_argv0=$(herdr --session navigator-linux-shell pane process-info --pane "$probe_pane" | jq -r '.result.process_info.foreground_processes[0].argv[0]')
herdr session stop navigator-linux-shell > /dev/null
wait_for '! running navigator-linux-shell' 150 || fail 'shell-check server did not stop'
herdr session delete navigator-linux-shell > /dev/null 2>&1
row default-shell info "no config.toml, SHELL unset: herdr starts $default_argv0; SHELL=/bin/bash: see record-on-hook"

step=link
herdr plugin link "$repo/plugin" > /dev/null || fail 'plugin link failed'
first=$(now_ms)
start_server SHELL=/bin/bash
return_log "$first"
[ "${ret%%"$tab"*}" = succeeded ] || fail "first cwd-return: $ret"
[ -s "$instance_file" ] || fail 'cwd-return wrote no server-run stamp'
server_pid=$(pgrep -f "herdr --session $SESSION server" | head -n 1)
server_start=$(sed 's/.*) //' "/proc/$server_pid/stat" | awk '{ print $20 }')
[ "$(cat "$instance_file")" = "$server_pid:$server_start" ] || fail "stamp $(cat "$instance_file") is not the server $server_pid:$server_start"
row server-instance pass "hooks are children of the server: stamp $(cat "$instance_file") = server pid:start; state dir $state"

step=record-on-hook
for label in moved control unknown mismatch; do
  created=$(h workspace create --cwd "$spawn" --label "$label")
  id=$(printf '%s' "$created" | jq -r '.result.root_pane.pane_id // empty')
  ws=$(printf '%s' "$created" | jq -r '.result.workspace.workspace_id // empty')
  [ -n "$id" ] && [ -n "$ws" ] || fail "workspace create $label failed: $created"
  eval "pane_$label=\$id ws_$label=\$ws"
done
all="$pane_moved $pane_control $pane_unknown $pane_mismatch"
sleep 2
hooks_ok "$first"
for id in $all; do
  shell_pid_of "$id"
  [ "$pid" = "$(info_pid "$id")" ] || fail "$id: shell \$\$ $pid differs from herdr shell_pid $(info_pid "$id")"
  [ "$(col "$id" 2)" = "$spawn" ] && [ "$(col "$id" 3)" = "$spawn" ] && [ "$(col "$id" 4)" = "$pid" ] || fail "$id line is '$(line_of "$id")', expected live and spawn $spawn, pid $pid"
  eval "pid_$(echo "$id" | tr ':' '_')=\$pid"
done
argv0=$(h pane process-info --pane "$pane_moved" | jq -r '.result.process_info.foreground_processes[0].argv[0]')
row record-on-hook pass "$hooks hooks succeeded; 4 lines <id> <live> <spawn> <pid>, pid = herdr shell_pid = the shell's \$\$ ($argv0)"

step=refresh-on-cd
type_in "$pane_moved" "cd $(quote "$sub")"
wait_for "cwd_is $pane_moved $(quote "$sub")" 100 || fail "pane list cwd of $pane_moved is $(pane_cwd "$pane_moved") after the cd"
live_info=$(info_cwd "$pane_moved")
[ "$live_info" = "$sub" ] || fail "process-info cwd after cd is $live_info"
sleep 2
[ "$(col "$pane_moved" 2)" = "$spawn" ] || fail "the record caught the cd with no hook: $(line_of "$pane_moved")"
focus_at=$(now_ms)
h workspace focus "$ws_control" > /dev/null || fail 'workspace focus failed'
wait_for "col_is $pane_moved 2 $(quote "$sub")" 100 || fail "focus hook did not record the cd: $(line_of "$pane_moved")"
hooks_ok "$focus_at"
[ "$(col "$pane_moved" 3)" = "$sub" ] || fail "spawn not refreshed to the process cwd: $(line_of "$pane_moved")"
row refresh-on-cd pass "with no shell configuration herdr's pane cwd and process-info cwd both follow cd ($sub); the next hook stores it as live and spawn"

step=autosave
session_json=$(herdr session list --json | jq -r --arg s "$SESSION" '.sessions[] | select(.name == $s) | .session_dir')/session.json
wait_for "jq -e --arg sub $(quote "$sub") '[.workspaces[].tabs[].panes[].cwd] | (length == 4) and (map(select(. == \$sub)) | length == 1)' $(quote "$session_json") > /dev/null 2>&1" 300 || fail 'herdr did not autosave the four panes with the cd folder'

step=setup-rows
# Rows return, unknown-spawn and mismatch stand in for a record whose live folder herdr did not restore (Linux restores the live folder by itself).
awk -F '\t' -v OFS='\t' -v m="$pane_moved" -v u="$pane_unknown" -v x="$pane_mismatch" -v o="$other" -v w="$wrong" '
  $1 == m { $2 = o }
  $1 == u { print $1, o; next }
  $1 == x { $2 = o; $3 = w }
  { print }' "$record" > "$record.new" && mv "$record.new" "$record" || fail 'cannot rewrite the record'
cp "$record" "$scratch/record.at-stop"

step=no-hook-at-stop
stop_server
cmp -s "$record" "$scratch/record.at-stop" || fail "the record changed during the stop: $(cat "$record")"
row no-hook-at-stop pass 'session stop ran no hook that rewrote the record'

step=restart
second=$(now_ms)
start_server SHELL=/bin/bash
return_log "$second"
rest=${ret#*"$tab"}
summary=${rest%%"$tab"*}
[ "${ret%%"$tab"*}" = succeeded ] || fail "cwd-return after the restart: $ret"
counts=$(printf '%s' "$summary" | sed -n 's/^cwd-return: \([0-9]*\) panes returned, \([0-9]*\) skipped (\(.*\))$/\1 \2 \3/p')
reasons=$(printf '%s' "${counts#* * }" | tr ',' '\n' | tr -d ' ' | sort | tr '\n' ' ')
[ "${counts%% *}" = 1 ] && [ "$reasons" = 'mismatch=1 same=1 unknown-spawn=1 ' ] || fail "unexpected cwd-return stdout: $summary"
sleep 1
at() { [ "$(pane_cwd "$1")" = "$2" ]; }

step=return
at "$pane_moved" "$other" || fail "$pane_moved is in $(pane_cwd "$pane_moved"), not returned to $other"
row return pass "$pane_moved restored by herdr into $sub, spawn check equal, cd'd to the recorded $other; log: $summary"

step=unknown-spawn
at "$pane_unknown" "$spawn" || fail "$pane_unknown is in $(pane_cwd "$pane_unknown")"
row unknown-spawn pass "$pane_unknown (line without spawn written right before the stop) skipped, stays in $spawn"

step=mismatch
at "$pane_mismatch" "$spawn" || fail "$pane_mismatch is in $(pane_cwd "$pane_mismatch")"
row mismatch pass "$pane_mismatch (stored spawn $wrong) skipped, stays in $spawn"

step=same
at "$pane_control" "$spawn" || fail "$pane_control is in $(pane_cwd "$pane_control")"
row same pass "$pane_control (never cd'd) restored by herdr into its recorded $spawn, counted same"

step=record-after
for id in $all; do
  old=$(eval "echo \$pid_$(echo "$id" | tr ':' '_')")
  new=$(info_pid "$id")
  [ "$(col "$id" 4)" = "$new" ] && [ "$new" != "$old" ] || fail "$id line '$(line_of "$id")' lacks the restored shell pid $new (was $old)"
  [ "$(col "$id" 3)" = "$(info_cwd "$id")" ] || fail "$id line '$(line_of "$id")' lacks the restored spawn $(info_cwd "$id")"
done
hooks_ok "$second"
row record-after pass "final merge stored each restored shell's pid and process cwd; $hooks hooks after the restart succeeded"
step=done
exit 0
