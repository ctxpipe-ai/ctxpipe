#!/bin/sh
# Stock docker:dind plus what the AWS sandbox host also applies
# (packages/aws-cdk/src/internal/sandbox-host-construct.ts). Compose runs this
# through the image's own `dind` wrapper, so cgroup nesting is already set up.
set -eu

# Sandboxes never reach cloud instance metadata (instance credentials when
# Compose runs on a cloud VM). The raw table drops before Docker's own rules,
# and the kernel applies it whichever iptables backend dockerd then picks; an
# nf_tables rule does not make the stock entrypoint switch to legacy. Fails
# closed: dockerd cannot run where neither backend works.
block_metadata() {
  "$1" -t raw -C PREROUTING -d 169.254.169.254/32 -j DROP 2>/dev/null ||
    "$1" -t raw -I PREROUTING -d 169.254.169.254/32 -j DROP 2>/dev/null
}
block_metadata iptables ||
  block_metadata /usr/local/sbin/.iptables-legacy/iptables || {
  echo 'ctxpipe: cannot add the instance-metadata block with iptables' >&2
  exit 1
}

# All sandboxes share one cgroup (`cgroup-parent` in daemon.json) capped at
# 85% of the memory this container may use, leaving room for dockerd.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  sandboxes=/sys/fs/cgroup/ctxpipe-sandboxes
  mkdir -p "$sandboxes"
  limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)
  if [ "$limit" = max ]; then
    limit=$(($(awk '/^MemTotal:/ { print $2 }' /proc/meminfo) * 1024))
  fi
  echo $((limit / 100 * 85)) >"$sandboxes/memory.max"
  echo 8192 >"$sandboxes/pids.max"
else
  echo 'ctxpipe: this host has no cgroup v2, so sandboxes run without the shared memory and process caps' >&2
fi

exec dockerd-entrypoint.sh "$@"
