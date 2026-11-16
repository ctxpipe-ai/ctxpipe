import { eq, sql } from "drizzle-orm"

import type { Env } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaceSandboxGitTokens } from "../db/schema/workspaces.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "../lib/connection-secrets.js"

/** The store of the run tokens. */
export type RunGitTokenStore = {
  get: (key: string) => Promise<{ token: string; mintedAt: Date } | null>
  /** Removes the record and returns the token it held, for revocation. */
  take: (key: string) => Promise<string | null>
  /** Records a token only when the key is free; false when another holds it. */
  add: (key: string, token: string) => Promise<boolean>
  /** Every record whose key starts with the prefix. */
  list: (
    prefix: string,
  ) => Promise<Array<{ key: string; token: string; mintedAt: Date }>>
}

/**
 * Encrypted GitHub read tokens for one organization: the run tokens of
 * conversations (keyed `run:<conversation>:…`) and ingest shards (keyed
 * `ingest:<run>:<shard>:…`), see `run-git-tokens.ts`.
 */
export function sandboxGitTokenStore(
  orgId: string,
  env: Env,
): RunGitTokenStore {
  return {
    get: (sandboxId) =>
      withOrgDbContext(orgId, async (db) => {
        const [row] = await db
          .select()
          .from(workspaceSandboxGitTokens)
          .where(eq(workspaceSandboxGitTokens.sandboxId, sandboxId))
          .limit(1)
        return row
          ? {
              token: decryptConnectionSecret(row.tokenCiphertext, env),
              mintedAt: row.mintedAt,
            }
          : null
      }),
    take: (sandboxId) =>
      withOrgDbContext(orgId, async (db) => {
        const [row] = await db
          .delete(workspaceSandboxGitTokens)
          .where(eq(workspaceSandboxGitTokens.sandboxId, sandboxId))
          .returning()
        return row ? decryptConnectionSecret(row.tokenCiphertext, env) : null
      }),
    add: (key, token) =>
      withOrgDbContext(orgId, async (db) => {
        const inserted = await db
          .insert(workspaceSandboxGitTokens)
          .values({
            sandboxId: key,
            orgId,
            tokenCiphertext: encryptConnectionSecret(token, env),
            mintedAt: new Date(),
          })
          .onConflictDoNothing({ target: workspaceSandboxGitTokens.sandboxId })
          .returning({ key: workspaceSandboxGitTokens.sandboxId })
        return inserted.length > 0
      }),
    list: (prefix) =>
      withOrgDbContext(orgId, async (db) => {
        const rows = await db
          .select()
          .from(workspaceSandboxGitTokens)
          .where(
            sql`starts_with(${workspaceSandboxGitTokens.sandboxId}, ${prefix})`,
          )
        return rows.map((row) => ({
          key: row.sandboxId,
          token: decryptConnectionSecret(row.tokenCiphertext, env),
          mintedAt: row.mintedAt,
        }))
      }),
  }
}
