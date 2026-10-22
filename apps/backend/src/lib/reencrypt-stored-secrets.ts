import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { type Db, getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations, twoFactors } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { workspaceSandboxGitTokens } from "../db/schema/workspaces.js"
import { reencryptConnectionSecret } from "./connection-secrets.js"

/**
 * Why a row stays on an old key: no configured key decrypts a value in it
 * (`decrypt`), it changed during the run (`changed`), or its UPDATE failed
 * (`write`).
 */
type FailReason = "decrypt" | "changed" | "write"

/** Counts of rows. `failed` holds row ids only, never a value. */
type ReencryptTally = {
  rewritten: number
  alreadyCurrent: number
  failed: { id: string; reason: FailReason }[]
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
 * Runs one compare-and-set UPDATE in a savepoint, unless `dryRun`. It keeps
 * no error: a query error holds the bound parameters, and they are
 * ciphertext.
 */
async function writeIfUnchanged(
  db: Db,
  dryRun: boolean,
  update: (savepoint: Savepoint) => Promise<unknown[]>,
): Promise<"written" | "changed" | "write"> {
  if (dryRun) return "written"
  try {
    const rows = await db.transaction((savepoint) => update(savepoint))
    return rows.length > 0 ? "written" : "changed"
  } catch {
    return "write"
  }
}

/** Counts one row that had values on an old key. */
function count(
  tally: ReencryptTally,
  id: string,
  result: "written" | FailReason,
): void {
  if (result === "written") tally.rewritten++
  else tally.failed.push({ id, reason: result })
}

/**
 * Moves the `…Enc` values of one connection config to the current key.
 * `undecryptable` is true when a value in it opens with no configured key;
 * the other values move all the same.
 */
function reencryptConfig(
  config: Record<string, unknown>,
  env: Env,
): { next: Record<string, unknown> | null; undecryptable: boolean } {
  let next: Record<string, unknown> | null = null
  let undecryptable = false
  for (const [field, value] of Object.entries(config)) {
    if (!field.endsWith("Enc") || typeof value !== "string") continue
    try {
      const rewritten = reencryptConnectionSecret(value, env)
      if (rewritten === null) continue
      next ??= { ...config }
      next[field] = rewritten
    } catch {
      undecryptable = true
    }
  }
  return { next, undecryptable }
}

async function reencryptOrg(
  orgId: string,
  env: Env,
  dryRun: boolean,
  report: ReencryptReport,
): Promise<void> {
  await withOrgDbContext(orgId, async (db) => {
    const connectionRows = await db
      .select({ id: connections.id, config: connections.config })
      .from(connections)
      .where(eq(connections.orgId, orgId))
    for (const row of connectionRows) {
      const tally = report.connections
      const { next, undecryptable } = reencryptConfig(row.config, env)
      if (!next) {
        if (undecryptable) count(tally, row.id, "decrypt")
        else tally.alreadyCurrent++
        continue
      }
      // Write only when nobody changed the config during this run.
      const result = await writeIfUnchanged(db, dryRun, (tx) =>
        tx
          .update(connections)
          .set({ config: next })
          .where(
            and(
              eq(connections.id, row.id),
              sql`${connections.config} = ${JSON.stringify(row.config)}::jsonb`,
            ),
          )
          .returning({ id: connections.id }),
      )
      count(
        tally,
        row.id,
        undecryptable && result === "written" ? "decrypt" : result,
      )
    }

    const tokenRows = await db
      .select()
      .from(workspaceSandboxGitTokens)
      .where(eq(workspaceSandboxGitTokens.orgId, orgId))
    for (const row of tokenRows) {
      const tally = report.sandboxGitTokens
      let rewritten: string | null
      try {
        rewritten = reencryptConnectionSecret(row.tokenCiphertext, env)
      } catch {
        count(tally, row.sandboxId, "decrypt")
        continue
      }
      if (rewritten === null) {
        tally.alreadyCurrent++
        continue
      }
      const result = await writeIfUnchanged(db, dryRun, (tx) =>
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
      )
      count(tally, row.sandboxId, result)
    }
  })
}

/**
 * Better Auth encrypts the TOTP secret and the backup codes with AUTH_SECRET.
 * Only PREVIOUS_AUTH_SECRET can decrypt an old value.
 */
async function reencryptTwoFactorValue(
  value: string,
  env: Env,
): Promise<string | null> {
  try {
    await symmetricDecrypt({ key: env.AUTH_SECRET, data: value })
    return null
  } catch {}
  if (!env.PREVIOUS_AUTH_SECRET) {
    throw new Error("No configured AUTH_SECRET decrypts this value")
  }
  const plaintext = await symmetricDecrypt({
    key: env.PREVIOUS_AUTH_SECRET,
    data: value,
  })
  return symmetricEncrypt({ key: env.AUTH_SECRET, data: plaintext })
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
        count(tally, row.id, "decrypt")
        continue
      }
      if (secret === null && backupCodes === null) {
        tally.alreadyCurrent++
        continue
      }
      const result = await writeIfUnchanged(db, dryRun, (tx) =>
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
      )
      count(tally, row.id, result)
    }
  }
}

/**
 * Encrypts every stored connector secret, sandbox Git token, and two-factor
 * secret again with the current key. Safe to run again: a value that the
 * current key encrypted stays as it is. With `dryRun`, it only counts. It
 * always does all organizations, so that no organization keeps old-key
 * values after a run that reports success. Each count is a row. A row that
 * it cannot decrypt, that changed during the run, or that it cannot write
 * goes into `failed` with the reason.
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
