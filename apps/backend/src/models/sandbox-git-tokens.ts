import { eq } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaceSandboxGitTokens } from "../db/schema/workspaces.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "../lib/connection-secrets.js"

export type SandboxGitTokenStore = {
  get: (sandboxId: string) => Promise<{ token: string; mintedAt: Date } | null>
  put: (sandboxId: string, token: string) => Promise<void>
  /** Removes the record and returns the token it held, for revocation. */
  take: (sandboxId: string) => Promise<string | null>
}

/** Encrypted per-sandbox GitHub read tokens for one organization. */
export function sandboxGitTokenStore(
  orgId: string,
  env: Env,
): SandboxGitTokenStore {
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
    put: (sandboxId, token) =>
      withOrgDbContext(orgId, async (db) => {
        const values = {
          tokenCiphertext: encryptConnectionSecret(token, env),
          mintedAt: new Date(),
        }
        await db
          .insert(workspaceSandboxGitTokens)
          .values({ sandboxId, orgId, ...values })
          .onConflictDoUpdate({
            target: workspaceSandboxGitTokens.sandboxId,
            set: values,
          })
      }),
    take: (sandboxId) =>
      withOrgDbContext(orgId, async (db) => {
        const [row] = await db
          .delete(workspaceSandboxGitTokens)
          .where(eq(workspaceSandboxGitTokens.sandboxId, sandboxId))
          .returning()
        return row ? decryptConnectionSecret(row.tokenCiphertext, env) : null
      }),
  }
}
