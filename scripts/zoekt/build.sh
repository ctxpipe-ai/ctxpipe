#!/bin/sh
# Builds the pinned zoekt-index and zoekt-webserver into .tools/bin of the
# checkout. The tool directives of go.mod in this folder pin the zoekt
# commit, and go.sum holds the checksum of each module. CI, the agent hosts
# and `factory check` use this build (scripts/checks/prerequisites.mjs,
# prerequisite `zoekt`). The codesearch image builds the same commit.
# Usage: scripts/zoekt/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="$(cd "$here/../.." && pwd)/.tools/bin"
mkdir -p "$bin"
cd "$here"
# proxy.golang.org occasionally resets a module zip mid-download.
n=0
until GOBIN="$bin" GOFLAGS=-mod=readonly go install tool; do
  n=$((n + 1))
  [ "$n" -lt 4 ] || exit 1
  sleep $((n * 4))
done
