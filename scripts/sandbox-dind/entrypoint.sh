#!/bin/sh
# Stock docker:dind plus the host protection the AWS sandbox host applies
# (packages/aws-cdk/src/internal/sandbox-host-construct.ts). Compose runs this
# through the image's own `dind` wrapper, so cgroup nesting is already set up.
set -eu

# Sandboxes never reach this daemon's own ports (other sandboxes' published
# agent ports, the Docker API) or cloud instance metadata. Fails closed.
iptables -C INPUT -i docker0 -j REJECT 2>/dev/null ||
  iptables -I INPUT -i docker0 -j REJECT
iptables -N DOCKER-USER 2>/dev/null || :
iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null ||
  iptables -I DOCKER-USER -d 169.254.169.254/32 -j REJECT

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
fi

exec dockerd-entrypoint.sh "$@"
