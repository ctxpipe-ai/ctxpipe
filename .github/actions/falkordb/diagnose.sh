#!/usr/bin/env bash
# Print the state of a stalled FalkorDB container, so that the next stall
# shows where each thread waits. Earlier stalls showed every server thread in
# a futex wait at 0 % CPU, but not which lock. This script ends the server
# (SIGSEGV for the Redis crash report), so run it only after a failure.
set -u
# The action and the CI step after the tests can both call this script.
if [ -e /tmp/falkordb-diagnosed ]; then
  echo "FalkorDB diagnostics are already in the log above"
  exit 0
fi
touch /tmp/falkordb-diagnosed
id=$(docker ps -aq --filter name='^falkordb$' | head -n 1)
[ -n "$id" ] || id=$(docker ps -q --filter publish=6379 | head -n 1)
if [ -z "$id" ]; then
  echo "No FalkorDB container found"
  docker ps -a
  exit 0
fi
section() { echo "::group::$1"; }
end() { echo "::endgroup::"; }

section "Runner"
uptime
free -m
cat /proc/sys/vm/overcommit_memory
nproc
sudo ss -ltnp
sudo dmesg | tail -n 50
end

section "Container"
docker ps -a
docker stats --no-stream
docker inspect "$id"
end

section "Health check results"
docker inspect --format '{{json .State.Health}}' "$id" | jq .
end

section "Container log"
docker logs --tail 200 "$id" 2>&1
end

section "Commands"
timeout 5 docker exec "$id" redis-cli INFO server clients memory cpu threads || echo "INFO did not answer (exit $?)"
timeout 5 docker exec "$id" redis-cli GRAPH.LIST || echo "GRAPH.LIST did not answer (exit $?)"
timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/6379 && printf "PING\r\n" >&3 && head -c 7 <&3' ||
  echo "PING from the runner through the published port did not answer (exit $?)"
end

pid=$(docker inspect --format '{{.State.Pid}}' "$id")
section "Threads and kernel stacks of server pid $pid"
docker top "$id" -eLo pid,tid,stat,wchan,pcpu,comm
for task in /proc/"$pid"/task/*; do
  echo "--- tid ${task##*/} $(cat "$task/comm" 2>/dev/null)"
  sudo cat "$task/stack" 2>/dev/null
done
end

section "User-space stacks of server pid $pid (gdb)"
if ! command -v gdb > /dev/null; then
  timeout 120 sudo apt-get install -y -qq --no-install-recommends gdb > /dev/null 2>&1 ||
    { timeout 120 sudo apt-get update -qq > /dev/null 2>&1 &&
      timeout 120 sudo apt-get install -y -qq --no-install-recommends gdb > /dev/null 2>&1; }
fi
if command -v gdb > /dev/null; then
  sudo timeout 90 gdb -p "$pid" -batch -nx \
    -ex "set sysroot /proc/$pid/root" -ex 'set pagination off' \
    -ex 'info threads' -ex 'thread apply all bt' 2>&1 | grep -v '^warning: ' | head -n 400
else
  echo "gdb is not available"
fi
end

section "Redis crash report (SIGSEGV)"
docker kill --signal=SEGV "$id" > /dev/null
sleep 5
docker logs --since 10s "$id" 2>&1 | head -n 400
end
