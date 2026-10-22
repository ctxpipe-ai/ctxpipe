/**
 * One-off: re-encrypt the stored connection secrets from the old key to
 * NEW_CONNECTION_SECRETS_ENCRYPTION_KEY. The old key is
 * OLD_CONNECTION_SECRETS_ENCRYPTION_KEY, or the key that OLD_AUTH_SECRET makes
 * when that is not set. Run it with the backend and the worker stopped, as the
 * database owner. Without --apply, it rolls back.
 *
 *   bun run src/scripts/reencryptConnectionSecrets.ts [--apply]
 */
import { Client } from "pg"
import type { Env } from "../config/env.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "../lib/connection-secrets.js"

const from = {
  AUTH_SECRET: process.env.OLD_AUTH_SECRET,
  CONNECTION_SECRETS_ENCRYPTION_KEY:
    process.env.OLD_CONNECTION_SECRETS_ENCRYPTION_KEY,
} as Env
const to = {
  CONNECTION_SECRETS_ENCRYPTION_KEY:
    process.env.NEW_CONNECTION_SECRETS_ENCRYPTION_KEY,
} as Env

function reencrypt(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("ctxv1:")) {
    return encryptConnectionSecret(decryptConnectionSecret(value, from), to)
  }
  if (Array.isArray(value)) return value.map(reencrypt)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, reencrypt(item)]),
    )
  }
  return value
}

const apply = process.argv.includes("--apply")
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
try {
  await db.query("begin")
  // Row-level security hides every row from ctxpipe_app, and the run would
  // then change nothing and still report success.
  const rls = await db.query(
    "select row_security_active('connections') or row_security_active('workspace_sandbox_git_tokens') as active",
  )
  if (rls.rows[0]?.active) {
    throw new Error(
      "Row-level security hides rows. Use the owner DATABASE_URL.",
    )
  }
  const connections = await db.query(
    "select id, config from connections for update",
  )
  for (const row of connections.rows) {
    await db.query("update connections set config = $2 where id = $1", [
      row.id,
      reencrypt(row.config),
    ])
  }
  const tokens = await db.query(
    "select sandbox_id, token_ciphertext from workspace_sandbox_git_tokens for update",
  )
  for (const row of tokens.rows) {
    await db.query(
      "update workspace_sandbox_git_tokens set token_ciphertext = $2 where sandbox_id = $1",
      [row.sandbox_id, reencrypt(row.token_ciphertext)],
    )
  }
  await db.query(apply ? "commit" : "rollback")
  process.stdout.write(
    `${connections.rowCount} connections, ${tokens.rowCount} sandbox tokens${apply ? "" : " (dry run, rolled back)"}\n`,
  )
} catch (error) {
  await db.query("rollback")
  throw error
} finally {
  await db.end()
}
