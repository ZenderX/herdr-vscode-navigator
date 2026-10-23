# Bound to workspace.focused to measure console flashes; the guard keeps it inert outside the probe session.
if ($env:HERDR_SESSION -ne 'navigator-discovery-probe') { exit 0 }
exit 0
