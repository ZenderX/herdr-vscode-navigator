#!/bin/sh
# The state dir is shared by all sessions, so the record is keyed by session name.
session=$(printf '%s' "${HERDR_SESSION:-default}" | tr -c 'A-Za-z0-9_.-' '_')

# Concurrent runs can finish out of order, so record the space focused now, not the event's.
# Labels containing a quote or backslash are escaped in JSON; those are skipped.
label=$("$HERDR_BIN_PATH" workspace list | sed -n 's/.*"focused":true,"label":"\([^"\\]*\)".*/\1/p')
[ -n "$label" ] || exit 0

printf '%s' "$label" > "$HERDR_PLUGIN_STATE_DIR/focused-$session.txt"
