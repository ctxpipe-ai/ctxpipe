import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { members, organizations, twoFactors } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { workspaceSandboxGitTokens } from "../db/schema/workspaces.js"
import {
  PREVIOUS_AUTH_SECRET_PREFIX,
  previousKeyEntries,
  reencryptConnectionSecret,
} from "./connection-secrets.js"

/** Counts of stored secret values. `failed` holds row ids (and fields) only, never a value. */
export type ReencryptTally = {
  rewritten: number
  alreadyCurrent: number
  failed: string[]
}

export type ReencryptReport = {
  dryRun: boolean
  connections: ReencryptTally
  sandboxGitTokens: ReencryptTally
  twoFactors: ReencryptTally
}

const BATCH = 100

function newTally(): ReencryptTally {
  return { rewritten: 0, alreadyCurrent: 0, failed: [] }
}

/** Moves the `…Enc` values of one connection config to the current key. */
function reencryptConfig(
  config: Record<string, unknown>,
  env: Env,
  tally: ReencryptTally,
  id: string,
): Record<string, unknown> | null {
  let next: Record<string, unknown> | null = null
  for (const [field, value] of Object.entries(config)) {
    if (!field.endsWith("Enc") || typeof value !== "string") continue
    try {
      const rewritten = reencryptConnectionSecret(value, env)
      if (rewritten === null) {
        tally.alreadyCurrent++
        continue
      }
      next ??= { ...config }
      next[field] = rewritten
      tally.rewritten++
    } catch {
      tally.failed.push(`${id}.${field}`)
    }
  }
  return next
}

async function reencryptOrg(
  orgId: string,
  env: Env,
  dryRun: boolean,
  report: ReencryptReport,
): Promise<void> {
  await withOrgDbContext(orgId, async (db) => {
    const rows = await db
      .select({ id: connections.id, config: connections.config })
      .from(connections)
      .where(eq(connections.orgId, orgId))
    for (const row of rows) {
      const next = reencryptConfig(row.config, env, report.connections, row.id)
      if (!next || dryRun) continue
      // Write only when nobody changed the config during this run.
      const updated = await db
        .update(connections)
        .set({ config: next })
        .where(
          and(
            eq(connections.id, row.id),
            sql`${connections.config} = ${JSON.stringify(row.config)}::jsonb`,
          ),
        )
        .returning({ id: connections.id })
      if (updated.length === 0) report.connections.failed.push(row.id)
    }
  })
  await withOrgDbContext(orgId, async (db) => {
    const rows = await db
      .select()
      .from(workspaceSandboxGitTokens)
      .where(eq(workspaceSandboxGitTokens.orgId, orgId))
    const tally = report.sandboxGitTokens
    for (const row of rows) {
      let rewritten: string | null
      try {
        rewritten = reencryptConnectionSecret(row.tokenCiphertext, env)
      } catch {
        tally.failed.push(row.sandboxId)
        continue
      }
      if (rewritten === null) {
        tally.alreadyCurrent++
        continue
      }
      tally.rewritten++
      if (dryRun) continue
      // A sandbox can put a new token meanwhile; that one is current already.
      await db
        .update(workspaceSandboxGitTokens)
        .set({ tokenCiphertext: rewritten })
        .where(
          and(
            eq(workspaceSandboxGitTokens.sandboxId, row.sandboxId),
            eq(workspaceSandboxGitTokens.tokenCiphertext, row.tokenCiphertext),
          ),
        )
    }
  })
}

/**
 * Better Auth encrypts the TOTP secret and the backup codes with AUTH_SECRET.
 * Only the `auth-secret:` entries of the previous keys can decrypt them.
 */
async function reencryptTwoFactorValue(
  value: string,
  env: Env,
): Promise<string | null> {
  try {
    await symmetricDecrypt({ key: env.AUTH_SECRET, data: value })
    return null
  } catch {}
  for (const entry of previousKeyEntries(
    env.CONNECTION_SECRETS_PREVIOUS_KEYS,
  )) {
    if (!entry.startsWith(PREVIOUS_AUTH_SECRET_PREFIX)) continue
    const key = entry.slice(PREVIOUS_AUTH_SECRET_PREFIX.length)
    let plaintext: string
    try {
      plaintext = await symmetricDecrypt({ key, data: value })
    } catch {
      continue
    }
    return symmetricEncrypt({ key: env.AUTH_SECRET, data: plaintext })
  }
  throw new Error("No configured AUTH_SECRET decrypts this value")
}

async function reencryptTwoFactors(
  env: Env,
  dryRun: boolean,
  tally: ReencryptTally,
  orgId: string | undefined,
): Promise<void> {
  const db = getSystemDb()
  const memberIds = orgId
    ? db
        .select({ userId: members.userId })
        .from(members)
        .where(eq(members.organizationId, orgId))
    : undefined
  let after = ""
  for (;;) {
    const rows = await db
      .select()
      .from(twoFactors)
      .where(
        and(
          gt(twoFactors.id, after),
          memberIds ? inArray(twoFactors.userId, memberIds) : undefined,
        ),
      )
      .orderBy(asc(twoFactors.id))
      .limit(BATCH)
    if (rows.length === 0) return
    after = rows.at(-1)?.id ?? after
    for (const row of rows) {
      let secret: string | null
      let backupCodes: string | null
      try {
        secret = await reencryptTwoFactorValue(row.secret, env)
        backupCodes = await reencryptTwoFactorValue(row.backupCodes, env)
      } catch {
        tally.failed.push(row.id)
        continue
      }
      if (secret === null && backupCodes === null) {
        tally.alreadyCurrent++
        continue
      }
      tally.rewritten++
      if (dryRun) continue
      await db
        .update(twoFactors)
        .set({
          secret: secret ?? row.secret,
          backupCodes: backupCodes ?? row.backupCodes,
        })
        .where(
          and(
            eq(twoFactors.id, row.id),
            eq(twoFactors.secret, row.secret),
            eq(twoFactors.backupCodes, row.backupCodes),
          ),
        )
    }
  }
}

/**
 * Encrypts every stored connector secret, sandbox Git token, and two-factor
 * secret again with the current key. Safe to run again: a value that the
 * current key encrypted stays as it is. With `dryRun`, it only counts. With
 * `orgId`, it does only that organization and the two-factor rows of its
 * members.
 */
export async function reencryptStoredSecrets(input: {
  env: Env
  dryRun: boolean
  orgId?: string
}): Promise<ReencryptReport> {
  const { env, dryRun, orgId } = input
  const report: ReencryptReport = {
    dryRun,
    connections: newTally(),
    sandboxGitTokens: newTally(),
    twoFactors: newTally(),
  }
  const db = getSystemDb()
  let after = ""
  for (;;) {
    const orgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          gt(organizations.id, after),
          orgId ? eq(organizations.id, orgId) : undefined,
        ),
      )
      .orderBy(asc(organizations.id))
      .limit(BATCH)
    if (orgs.length === 0) break
    after = orgs.at(-1)?.id ?? after
    for (const org of orgs) await reencryptOrg(org.id, env, dryRun, report)
  }
  await reencryptTwoFactors(env, dryRun, report.twoFactors, orgId)
  return report
}
