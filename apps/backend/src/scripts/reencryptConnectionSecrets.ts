/**
 * Re-encrypts the stored connection secrets (integration tokens, OAuth client
 * secrets, webhook secrets, sandbox Git tokens) from an old key to a new key.
 * Run it while the backend and the worker are stopped. Procedure:
 * infra/README.md, "Connection secrets key".
 *
 * Environment: DATABASE_URL (owner URL), OLD_AUTH_SECRET (the AUTH_SECRET
 * that made the current key), NEW_CONNECTION_SECRETS_ENCRYPTION_KEY (64 hex
 * characters).
 *
 *   bun run src/scripts/reencryptConnectionSecrets.ts [--apply]
 *
 * When the current key is an explicit key, set OLD_CONNECTION_SECRETS_ENCRYPTION_KEY
 * in place of OLD_AUTH_SECRET. Use the owner role (for example neondb_owner):
 * row-level security hides every row from ctxpipe_app. Without --apply, it
 * decrypts each value and rolls back. It prints a JSON report with counts
 * only, never a value.
 */
import { Pool } from "pg"
import { ownerUrlForMigrate } from "../db/owner-migrate-url.js"
import { reencryptConnectionSecrets } from "../db/reencrypt-connection-secrets.js"

const databaseUrl = process.env.DATABASE_URL
const oldKey = process.env.OLD_CONNECTION_SECRETS_ENCRYPTION_KEY
const oldAuthSecret = process.env.OLD_AUTH_SECRET
const newKey = process.env.NEW_CONNECTION_SECRETS_ENCRYPTION_KEY
if (!databaseUrl) throw new Error("Set DATABASE_URL to the owner URL")
if (!oldKey && !oldAuthSecret) {
  throw new Error(
    "Set OLD_AUTH_SECRET or OLD_CONNECTION_SECRETS_ENCRYPTION_KEY",
  )
}
const hexKey = /^[0-9a-fA-F]{64}$/
if (oldKey && !hexKey.test(oldKey)) {
  throw new Error(
    "OLD_CONNECTION_SECRETS_ENCRYPTION_KEY must be 64 hex characters",
  )
}
if (!newKey || !hexKey.test(newKey)) {
  throw new Error(
    "Set NEW_CONNECTION_SECRETS_ENCRYPTION_KEY to 64 hex characters (openssl rand -hex 32)",
  )
}

const url = new URL(ownerUrlForMigrate(databaseUrl))
const pool = new Pool({ connectionString: url.toString(), max: 1 })
const client = await pool.connect()
try {
  const report = await reencryptConnectionSecrets({
    client,
    from: {
      AUTH_SECRET: oldAuthSecret ?? "",
      CONNECTION_SECRETS_ENCRYPTION_KEY: oldKey,
    },
    to: { AUTH_SECRET: "", CONNECTION_SECRETS_ENCRYPTION_KEY: newKey },
    apply: process.argv.includes("--apply"),
  })
  process.stdout.write(
    `${JSON.stringify({ database: `${url.host}${url.pathname}`, ...report }, null, 2)}\n`,
  )
} finally {
  client.release()
  await pool.end()
}
