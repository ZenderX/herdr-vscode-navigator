#!/bin/sh
# Builds the probe image (cached after the first run) and runs probe.sh in a throwaway container against the plugin's sh scripts. Needs a running Docker engine; run from Git Bash on Windows or any POSIX shell.
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
image=herdr-navigator-probe:0.9.5
name=herdr-navigator-probe-$$
# Git Bash would rewrite the container-side paths below into Windows paths.
export MSYS_NO_PATHCONV=1
host_repo=$( (cd "$repo" && pwd -W) 2> /dev/null || printf '%s' "$repo")

docker info > /dev/null 2>&1 || { echo 'run.sh: no Docker engine answers; start Docker Desktop (or dockerd) first' >&2; exit 1; }
docker build -q -t "$image" "$host_repo/scripts/cwd-restore-probe/linux" > /dev/null || { echo "run.sh: docker build of $image failed" >&2; exit 1; }
trap 'docker rm -f "$name" > /dev/null 2>&1' EXIT
trap 'exit 1' HUP INT TERM
docker run --rm --name "$name" -v "$host_repo:/repo:ro" "$image" sh /repo/scripts/cwd-restore-probe/linux/probe.sh
