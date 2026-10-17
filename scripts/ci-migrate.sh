#!/usr/bin/env bash
# Apply Drizzle migrations to an empty database, then again as an upgrade from
# origin/main's schema. Requires DATABASE_URL to a Postgres that can CREATE DATABASE.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
admin_url="${DATABASE_URL:?DATABASE_URL is required}"
base_ref="${MIGRATE_BASE_REF:-origin/main}"

psql_admin() {
  psql "$admin_url" -v ON_ERROR_STOP=1 "$@"
}

db_url_for() {
  local name="$1"
  python3 - "$admin_url" "$name" <<'PY'
import sys
from urllib.parse import urlparse, urlunparse
url, name = sys.argv[1], sys.argv[2]
parsed = urlparse(url)
print(urlunparse(parsed._replace(path=f"/{name}")))
PY
}

migrate_with_folder() {
  local url="$1"
  local folder="$2"
  local tmp_config
  tmp_config="$(mktemp --suffix=.ts)"
  cat >"$tmp_config" <<EOF
import { defineConfig } from "drizzle-kit"
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "$folder",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
})
EOF
  (
    cd "$root/apps/backend"
    DATABASE_URL="$url" pnpm exec drizzle-kit migrate --config "$tmp_config"
  )
  rm -f "$tmp_config"
}

echo "== Fresh migrate =="
psql_admin -c 'DROP DATABASE IF EXISTS ctxpipe_migrate_fresh;'
psql_admin -c 'CREATE DATABASE ctxpipe_migrate_fresh;'
migrate_with_folder "$(db_url_for ctxpipe_migrate_fresh)" "$root/apps/backend/migrations"
echo "Fresh migrate succeeded."

echo "== Upgrade from $base_ref =="
if ! git -C "$root" rev-parse --verify "$base_ref" >/dev/null 2>&1; then
  echo "Missing $base_ref; fetching..."
  git -C "$root" fetch origin main
fi

previous="$(mktemp -d)"
git -C "$root" archive "$base_ref" apps/backend/migrations | tar -x -C "$previous"
previous_migrations="$previous/apps/backend/migrations"
if [[ ! -d "$previous_migrations" ]]; then
  echo "No migrations on $base_ref; treating upgrade as fresh-only."
  rm -rf "$previous"
  exit 0
fi

psql_admin -c 'DROP DATABASE IF EXISTS ctxpipe_migrate_upgrade;'
psql_admin -c 'CREATE DATABASE ctxpipe_migrate_upgrade;'
upgrade_url="$(db_url_for ctxpipe_migrate_upgrade)"
migrate_with_folder "$upgrade_url" "$previous_migrations"
migrate_with_folder "$upgrade_url" "$root/apps/backend/migrations"
rm -rf "$previous"
echo "Upgrade migrate succeeded."
