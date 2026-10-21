#!/bin/sh
session=$(printf '%s' "${HERDR_SESSION:-default}" | tr -c 'A-Za-z0-9_.-' '_')

file="$HERDR_PLUGIN_STATE_DIR/focused-$session.txt"
[ -r "$file" ] || exit 0
label=$(cat "$file")
[ -n "$label" ] || exit 0

# One line per space starting at its label; "workspace_id" follows the label in the same object.
id=$("$HERDR_BIN_PATH" workspace list | sed 's/"label":"/\
&/g' | WANT="$label" awk '
  index($0, "\"label\":\"" ENVIRON["WANT"] "\"") == 1 && match($0, /"workspace_id":"[^"]*"/) {
    print substr($0, RSTART + 16, RLENGTH - 17); exit
  }')
# The space may have been closed since it was recorded.
[ -n "$id" ] || exit 0

"$HERDR_BIN_PATH" workspace focus "$id" > /dev/null
