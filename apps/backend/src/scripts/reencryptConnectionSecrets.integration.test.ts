import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ownerUrlForMigrate } from "../db/owner-migrate-url.js"

const script = fileURLToPath(
  new URL("./reencryptConnectionSecrets.ts", import.meta.url),
)
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
// The script changes each row of its tables, so it gets a database of its own.
const database = `ctxpipe_test_reencrypt_${suffix}`
const oldSecret = "old-auth-secret-of-this-test-0123456789"
const newSecret = "new-auth-secret-of-this-test-9876543210"
const totpSecret = "TOTPSECRETOFTHISTESTONLY01234567"
const backupCodes = JSON.stringify(["aaaaa-bbbbb", "ccccc-ddddd"])

let admin: pg.Client
let db: pg.Client
let databaseUrl: string

function run(env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl, ...env },
    encoding: "utf8",
    timeout: 60_000,
  })
}

async function storedRow(id: string) {
  const result = await db.query<{ secret: string; backup_codes: string }>(
    "select secret, backup_codes from two_factors where id = $1",
    [id],
  )
  const row = result.rows[0]
  if (!row) throw new Error(`no two_factors row ${id}`)
  return row
}

/** Write a row the way the Better Auth two-factor plugin does. */
async function insertTwoFactor(id: string, secret: string) {
  await db.query(
    "insert into two_factors (id, secret, backup_codes, user_id) values ($1, $2, $3, $4)",
    [
      id,
      await symmetricEncrypt({ key: secret, data: totpSecret }),
      await symmetricEncrypt({ key: secret, data: backupCodes }),
      `user_${id}`,
    ],
  )
}

describe("reencryptConnectionSecrets two-factor rows", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    await admin.query(`create database "${database}"`)
    ownerUrl.pathname = `/${database}`
    databaseUrl = ownerUrl.toString()
    db = new pg.Client({ connectionString: databaseUrl })
    await db.connect()
    // Only the columns that the script reads and writes.
    await db.query(`
      create table connections (id text primary key, config jsonb);
      create table workspace_sandbox_git_tokens (sandbox_id text primary key, token_ciphertext text not null);
      create table two_factors (id text primary key, secret text not null, backup_codes text not null, user_id text not null);
    `)
    await insertTwoFactor("tfa_one", oldSecret)
  })

  afterAll(async () => {
    await db?.end()
    await admin?.query(`drop database if exists "${database}" with (force)`)
    await admin?.end()
  })

  it("skips two-factor rows and says so when OLD_AUTH_SECRET is not set", async () => {
    const before = await storedRow("tfa_one")
    const result = run({ NEW_AUTH_SECRET: newSecret }, "--apply")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("two-factor rows skipped")
    expect(await storedRow("tfa_one")).toEqual(before)
  })

  it("changes nothing without --apply", async () => {
    const before = await storedRow("tfa_one")
    const result = run({
      OLD_AUTH_SECRET: oldSecret,
      NEW_AUTH_SECRET: newSecret,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("1 two-factor rows")
    expect(result.stdout).toContain("rolled back")
    expect(await storedRow("tfa_one")).toEqual(before)
  })

  it("fails, names only the row id, and changes nothing when a row does not decrypt", async () => {
    await insertTwoFactor(
      "tfa_other_secret",
      "some-other-secret-0123456789abcdef",
    )
    const before = await storedRow("tfa_one")
    const result = run(
      { OLD_AUTH_SECRET: oldSecret, NEW_AUTH_SECRET: newSecret },
      "--apply",
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("tfa_other_secret")
    expect(result.stderr).not.toContain(oldSecret)
    expect(result.stderr).not.toContain(newSecret)
    expect(await storedRow("tfa_one")).toEqual(before)
    await db.query("delete from two_factors where id = 'tfa_other_secret'")
  })

  it("re-encrypts the TOTP secret and the backup codes with --apply", async () => {
    const result = run(
      { OLD_AUTH_SECRET: oldSecret, NEW_AUTH_SECRET: newSecret },
      "--apply",
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain(totpSecret)
    const row = await storedRow("tfa_one")
    expect(await symmetricDecrypt({ key: newSecret, data: row.secret })).toBe(
      totpSecret,
    )
    expect(
      await symmetricDecrypt({ key: newSecret, data: row.backup_codes }),
    ).toBe(backupCodes)
    await expect(
      symmetricDecrypt({ key: oldSecret, data: row.secret }),
    ).rejects.toThrow()
  })
})
