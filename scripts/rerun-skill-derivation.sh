#!/usr/bin/env bash
# Thin wrapper: rerun Phase-2 skill derivation from persisted InstructionUnit rows.
# See apps/backend/docs/rerun-skill-derivation.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/backend"
exec pnpm run rerun-skill-derivation -- "$@"
