#!/usr/bin/env bash
# Apply schema as the table owner, then GRANT DML to ctxpipe_app.
# Runtime DATABASE_URL (ctxpipe_app) stays in .env.local; this shell uses the owner URL.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/apps/backend"

# Linked worktrees: CREATE DATABASE if needed and export owner DATABASE_URL.
# shellcheck source=worktree-db.sh
source "$root/scripts/worktree-db.sh"

DATABASE_URL="$(pnpm exec tsx src/db/print-owner-migrate-url.ts)"
export DATABASE_URL

pnpm exec drizzle-kit migrate
pnpm exec tsx src/db/migrate-openworkflow.ts

export DATABASE_APP_PASSWORD="${DATABASE_APP_PASSWORD:-ctxpipe}"
pnpm exec tsx src/db/provision-app-role-cli.ts
