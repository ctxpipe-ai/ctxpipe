/**
 * One-off: re-encrypt the stored connection secrets from the old key to
 * NEW_CONNECTION_SECRETS_ENCRYPTION_KEY. The old key is
 * OLD_CONNECTION_SECRETS_ENCRYPTION_KEY, or the key that OLD_AUTH_SECRET makes
 * when that is not set. When NEW_AUTH_SECRET is set, it also re-encrypts the
 * Better Auth two-factor rows (the TOTP secret and the backup codes) from
 * OLD_AUTH_SECRET to NEW_AUTH_SECRET in the same transaction. NEW_AUTH_SECRET
 * without OLD_AUTH_SECRET stops the script before it changes a row. Run it with the backend and the worker stopped, as the database
 * owner. Without --apply, it rolls back.
 *
 *   bun run src/scripts/reencryptConnectionSecrets.ts [--apply]
 */
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
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
    if (!to.CONNECTION_SECRETS_ENCRYPTION_KEY) {
      throw new Error(
        "Connection secrets exist and NEW_CONNECTION_SECRETS_ENCRYPTION_KEY is not set. Export it (the current key when only AUTH_SECRET changes). Nothing changed.",
      )
    }
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

const oldAuthSecret = process.env.OLD_AUTH_SECRET
const newAuthSecret = process.env.NEW_AUTH_SECRET
// Without the old secret, the two-factor rows stay on it while the services
// start on the new one, and every user with two-factor sign-in is locked out.
if (newAuthSecret && !oldAuthSecret) {
  throw new Error(
    "NEW_AUTH_SECRET is set and OLD_AUTH_SECRET is not. Export OLD_AUTH_SECRET with the current AUTH_SECRET value, or unset NEW_AUTH_SECRET when AUTH_SECRET does not change. Nothing changed.",
  )
}

/**
 * Better Auth gets `secret: AUTH_SECRET` and no `secrets` list, so the
 * two-factor plugin encrypts with the plain secret string as the key.
 */
async function reencryptTwoFactor(
  id: string,
  value: string,
  oldKey: string,
  newKey: string,
): Promise<string> {
  let plaintext: string
  try {
    plaintext = await symmetricDecrypt({ key: oldKey, data: value })
  } catch {
    throw new Error(
      `two_factors row ${id} does not decrypt with OLD_AUTH_SECRET. Nothing changed.`,
    )
  }
  return symmetricEncrypt({ key: newKey, data: plaintext })
}

const apply = process.argv.includes("--apply")
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
try {
  await db.query("begin")
  // Row-level security hides every row from ctxpipe_app, and the run would
  // then change nothing and still report success.
  const rls = await db.query(
    "select row_security_active('connections') or row_security_active('workspace_sandbox_git_tokens') or row_security_active('two_factors') as active",
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
  let twoFactorSummary = ""
  if (oldAuthSecret && newAuthSecret) {
    const twoFactors = await db.query(
      "select id, secret, backup_codes from two_factors for update",
    )
    for (const row of twoFactors.rows) {
      await db.query(
        "update two_factors set secret = $2, backup_codes = $3 where id = $1",
        [
          row.id,
          await reencryptTwoFactor(
            row.id,
            row.secret,
            oldAuthSecret,
            newAuthSecret,
          ),
          await reencryptTwoFactor(
            row.id,
            row.backup_codes,
            oldAuthSecret,
            newAuthSecret,
          ),
        ],
      )
    }
    twoFactorSummary = `, ${twoFactors.rowCount} two-factor rows`
  }
  await db.query(apply ? "commit" : "rollback")
  process.stdout.write(
    `${connections.rowCount} connections, ${tokens.rowCount} sandbox tokens${twoFactorSummary}${apply ? "" : " (dry run, rolled back)"}\n`,
  )
} catch (error) {
  await db.query("rollback")
  throw error
} finally {
  await db.end()
}
