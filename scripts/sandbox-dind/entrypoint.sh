#!/bin/sh
# Stock docker:dind plus the host protection the AWS sandbox host applies
# (packages/aws-cdk/src/internal/sandbox-host-construct.ts). Compose runs this
# through the image's own `dind` wrapper, so cgroup nesting is already set up.
set -eu

# Sandboxes never reach this daemon's own ports (other sandboxes' published
# agent ports, the Docker API). Fails closed.
iptables -C INPUT -i docker0 -j REJECT 2>/dev/null ||
  iptables -I INPUT -i docker0 -j REJECT

# Outside this daemon, sandboxes reach the `sandbox` network (backend, worker)
# and the internet only: not the Compose host, whose published ports include
# Postgres, nor other private networks such as the app network (Docker routes
# to published container ports across networks), nor instance metadata.
# This stands in for the AWS security groups.
uplink=$(ip -o -4 route show default | awk '{ print $5; exit }')
gateway=$(ip -o -4 route show default | awk '{ print $3; exit }')
subnet=$(ip -o -4 addr show dev "$uplink" | awk '{ print $4; exit }')
iptables -N CTXPIPE-SANDBOX-EGRESS 2>/dev/null || iptables -F CTXPIPE-SANDBOX-EGRESS
iptables -A CTXPIPE-SANDBOX-EGRESS -d "$gateway" -j REJECT
iptables -A CTXPIPE-SANDBOX-EGRESS -d "$subnet" -j RETURN
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -A CTXPIPE-SANDBOX-EGRESS -d "$range" -j REJECT
done
iptables -N DOCKER-USER 2>/dev/null || :
iptables -C DOCKER-USER -i docker0 -j CTXPIPE-SANDBOX-EGRESS 2>/dev/null ||
  iptables -I DOCKER-USER -i docker0 -j CTXPIPE-SANDBOX-EGRESS

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
