#!/usr/bin/env bash
# Local dev migrate: the same entry point as hosted, Compose and CDK
# (apps/backend/src/db/migrate.ts), on the owner URL.
# Runtime DATABASE_URL (ctxpipe_app) stays in .env.local; this shell uses the owner URL.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/apps/backend"

# Linked worktrees: CREATE DATABASE if needed and export owner DATABASE_URL.
# shellcheck source=worktree-db.sh
source "$root/scripts/worktree-db.sh"

DATABASE_URL="$(pnpm exec tsx src/db/print-owner-migrate-url.ts)"
export DATABASE_URL
export DATABASE_APP_PASSWORD="${DATABASE_APP_PASSWORD:-ctxpipe}"
pnpm exec tsx src/db/migrate.ts
