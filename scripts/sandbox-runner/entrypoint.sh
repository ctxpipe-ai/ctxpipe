#!/bin/sh
set -eu

# The infrastructure runner owns this volume. Agent containers never mount it.
state=/var/lib/ctxpipe-sandbox-storage
data=/var/lib/docker
size=${CTXPIPE_SANDBOX_STORAGE_GIB:-64}
case "$size" in
  ''|*[!0-9]*) echo 'CTXPIPE_SANDBOX_STORAGE_GIB must be an integer' >&2; exit 1 ;;
esac
if [ "$size" -lt 8 ]; then
  echo 'CTXPIPE_SANDBOX_STORAGE_GIB must be at least 8' >&2
  exit 1
fi
mkdir -p "$state" "$data"
exec 9>"$state/runner.lock"
flock -n 9 || { echo 'Sandbox storage is already owned by another runner' >&2; exit 1; }

# Publish only a successfully formatted new filesystem; never reformat a saved one.
if [ ! -e "$state/data.img" ]; then
  truncate -s "${size}G" "$state/data.img.new"
  mkfs.btrfs -f "$state/data.img.new"
  mv "$state/data.img.new" "$state/data.img"
fi
mount -t btrfs -o loop "$state/data.img" "$data"
daemon_pid=''
cleanup() {
  if [ -n "$daemon_pid" ]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" || true
  fi
  umount "$data"
}
trap cleanup EXIT
trap 'exit 0' TERM INT
btrfs quota enable "$data"

# Keep Docker's native TLS, cgroup setup, snapshot and restore implementations.
dockerd-entrypoint.sh --storage-driver=btrfs --data-root="$data" "$@" &
daemon_pid=$!
wait "$daemon_pid"
