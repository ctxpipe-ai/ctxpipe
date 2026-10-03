#!/bin/sh
set -eu

# The relay shares DinD's network namespace, so discovery needs no Docker API
# credentials or socket. docker0 is the default bridge used by the native proxy.
gateway=$(ip -4 addr show dev docker0 | awk '$1 == "inet" { split($2, address, "/"); print address[1] }')
if ! printf '%s\n' "$gateway" | awk -F. '
  NF != 4 { exit 1 }
  {
    for (i = 1; i <= 4; i++)
      if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
  }
'; then
  echo 'nested Docker bridge has no valid IPv4 gateway' >&2
  exit 1
fi
case "$gateway" in
  0.0.0.0|127.*) echo 'refusing unsafe model relay bind address' >&2; exit 1 ;;
esac

if [ "${1:-}" = --check ]; then
  busybox netstat -lnt | awk -v endpoint="$gateway:3000" '
    $4 == endpoint { found = 1 }
    END { exit !found }
  '
  exit
fi

# The target name is resolved for each accepted connection, so replacing the
# backend container does not pin its old address. Never broaden this bind.
exec socat \
  "TCP4-LISTEN:3000,bind=$gateway,reuseaddr,fork" \
  "TCP4:backend:3000"
