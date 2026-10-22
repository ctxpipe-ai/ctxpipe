import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { type Db, getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations, twoFactors } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { workspaceSandboxGitTokens } from "../db/schema/workspaces.js"
import {
  PREVIOUS_AUTH_SECRET_PREFIX,
  previousKeyEntries,
  reencryptConnectionSecret,
} from "./connection-secrets.js"

/** Counts of stored secret values. `failed` holds row ids (and fields) only, never a value. */
type ReencryptTally = {
  rewritten: number
  alreadyCurrent: number
  failed: string[]
}

type ReencryptReport = {
  dryRun: boolean
  connections: ReencryptTally
  sandboxGitTokens: ReencryptTally
  twoFactors: ReencryptTally
}

const BATCH = 100

type Savepoint = Parameters<Parameters<Db["transaction"]>[0]>[0]

function newTally(): ReencryptTally {
  return { rewritten: 0, alreadyCurrent: 0, failed: [] }
}

/**
 * Runs one compare-and-set UPDATE in a savepoint. Returns false when the
 * UPDATE fails or changes no row. It keeps no error: a query error holds the
 * bound parameters, and they are ciphertext.
 */
async function writeIfUnchanged(
  db: Db,
  update: (savepoint: Savepoint) => Promise<unknown[]>,
): Promise<boolean> {
  try {
    const rows = await db.transaction((savepoint) => update(savepoint))
    return rows.length > 0
  } catch {
    return false
  }
}

/** Moves the `…Enc` values of one connection config to the current key. */
function reencryptConfig(
  config: Record<string, unknown>,
  env: Env,
  tally: ReencryptTally,
  id: string,
): { next: Record<string, unknown>; fields: number } | null {
  let next: Record<string, unknown> | null = null
  let fields = 0
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
      fields++
    } catch {
      tally.failed.push(`${id}.${field}`)
    }
  }
  return next ? { next, fields } : null
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
    const tally = report.connections
    for (const row of rows) {
      const result = reencryptConfig(row.config, env, tally, row.id)
      if (!result) continue
      // Write only when nobody changed the config during this run.
      const written =
        dryRun ||
        (await writeIfUnchanged(db, (tx) =>
          tx
            .update(connections)
            .set({ config: result.next })
            .where(
              and(
                eq(connections.id, row.id),
                sql`${connections.config} = ${JSON.stringify(row.config)}::jsonb`,
              ),
            )
            .returning({ id: connections.id }),
        ))
      if (written) tally.rewritten += result.fields
      else tally.failed.push(row.id)
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
      const written =
        dryRun ||
        (await writeIfUnchanged(db, (tx) =>
          tx
            .update(workspaceSandboxGitTokens)
            .set({ tokenCiphertext: rewritten })
            .where(
              and(
                eq(workspaceSandboxGitTokens.sandboxId, row.sandboxId),
                eq(
                  workspaceSandboxGitTokens.tokenCiphertext,
                  row.tokenCiphertext,
                ),
              ),
            )
            .returning({ id: workspaceSandboxGitTokens.sandboxId }),
        ))
      if (written) tally.rewritten++
      else tally.failed.push(row.sandboxId)
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
): Promise<void> {
  const db = getSystemDb()
  let after = ""
  for (;;) {
    const rows = await db
      .select()
      .from(twoFactors)
      .where(gt(twoFactors.id, after))
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
      const written =
        dryRun ||
        (await writeIfUnchanged(db, (tx) =>
          tx
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
            .returning({ id: twoFactors.id }),
        ))
      if (written) tally.rewritten++
      else tally.failed.push(row.id)
    }
  }
}

/**
 * Encrypts every stored connector secret, sandbox Git token, and two-factor
 * secret again with the current key. Safe to run again: a value that the
 * current key encrypted stays as it is. With `dryRun`, it only counts. It
 * always does all organizations, so that no organization keeps old-key
 * values after a run that reports success. A row that changed during the run,
 * or that it cannot write, goes into `failed`.
 */
export async function reencryptStoredSecrets(input: {
  env: Env
  dryRun: boolean
}): Promise<ReencryptReport> {
  const { env, dryRun } = input
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
      .where(gt(organizations.id, after))
      .orderBy(asc(organizations.id))
      .limit(BATCH)
    if (orgs.length === 0) break
    after = orgs.at(-1)?.id ?? after
    for (const org of orgs) await reencryptOrg(org.id, env, dryRun, report)
  }
  await reencryptTwoFactors(env, dryRun, report.twoFactors)
  return report
}
