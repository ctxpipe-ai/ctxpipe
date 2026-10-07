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

# Sandboxes reach only Agent Vault's proxy (CTXPIPE_SANDBOX_PROXY, ip:port),
# which adds credentials outside the sandbox and forwards HTTP(S) to the
# internet. Everything else from a sandbox bridge is dropped: direct
# connections, the backend, DinD itself, and DNS (a client that uses the
# proxy sends host names to it, so sandboxes resolve no names). Replies to
# connections the backend opens to a sandbox are kept. The mangle table runs
# before Docker's filter rules, whichever iptables backend dockerd picks.
force_proxy() {
  ipt=$1
  proxy_ip=${CTXPIPE_SANDBOX_PROXY%:*}
  proxy_port=${CTXPIPE_SANDBOX_PROXY##*:}
  "$ipt" -t mangle -N CTXPIPE-SANDBOX 2>/dev/null || "$ipt" -t mangle -F CTXPIPE-SANDBOX || return 1
  "$ipt" -t mangle -A CTXPIPE-SANDBOX -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN &&
    "$ipt" -t mangle -A CTXPIPE-SANDBOX -p tcp -d "$proxy_ip" --dport "$proxy_port" -j RETURN &&
    "$ipt" -t mangle -A CTXPIPE-SANDBOX -j DROP || return 1
  for chain in FORWARD INPUT; do
    for bridge in docker0 br-+; do
      "$ipt" -t mangle -C "$chain" -i "$bridge" -j CTXPIPE-SANDBOX 2>/dev/null ||
        "$ipt" -t mangle -I "$chain" -i "$bridge" -j CTXPIPE-SANDBOX || return 1
    done
  done
}
# IPv6: the proxy has an IPv4 address only, so sandboxes get no IPv6 at all
# (replies to the backend's connections stay).
block_ipv6() {
  ipt=$1
  "$ipt" -t mangle -N CTXPIPE-SANDBOX 2>/dev/null || "$ipt" -t mangle -F CTXPIPE-SANDBOX || return 1
  "$ipt" -t mangle -A CTXPIPE-SANDBOX -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN &&
    "$ipt" -t mangle -A CTXPIPE-SANDBOX -j DROP || return 1
  for chain in FORWARD INPUT; do
    for bridge in docker0 br-+; do
      "$ipt" -t mangle -C "$chain" -i "$bridge" -j CTXPIPE-SANDBOX 2>/dev/null ||
        "$ipt" -t mangle -I "$chain" -i "$bridge" -j CTXPIPE-SANDBOX || return 1
    done
  done
}
if [ -n "${CTXPIPE_SANDBOX_PROXY:-}" ]; then
  force_proxy iptables 2>/dev/null ||
    force_proxy /usr/local/sbin/.iptables-legacy/iptables || {
    echo 'ctxpipe: cannot force sandbox traffic through Agent Vault with iptables' >&2
    exit 1
  }
  # Fails closed: where IPv6 is on and ip6tables does not work, dind stops.
  if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" != 1 ]; then
    block_ipv6 ip6tables 2>/dev/null ||
      block_ipv6 /usr/local/sbin/.iptables-legacy/ip6tables || {
      echo 'ctxpipe: cannot block sandbox IPv6 with ip6tables' >&2
      exit 1
    }
  fi
fi

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
