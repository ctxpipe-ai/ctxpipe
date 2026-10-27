import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { getAuth, resetBetterAuthForTests } from "../auth/config.js"
import type { Env } from "../config/env.js"
import { closeDb, initDb } from "../db/client.js"
import { ownerUrlForMigrate } from "../db/owner-migrate-url.js"
import { runMigrations } from "../db/run-migrations.js"
import { encryptConnectionSecret } from "../lib/connection-secrets.js"

const script = fileURLToPath(
  new URL("./reencryptConnectionSecrets.ts", import.meta.url),
)
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
// The script changes each row of its tables, so it gets a database of its own.
const database = `ctxpipe_test_reencrypt_${suffix}`
// A role of this run only, so that the shared ctxpipe_app is not changed.
const roleName = `ctxpipe_app_reencrypt_${suffix}`
const base = "http://localhost:3000"
const oldSecret = "old-auth-secret-of-this-test-0123456789"
const newSecret = "new-auth-secret-of-this-test-9876543210"
const totpSecret = "TOTPSECRETOFTHISTESTONLY01234567"
const backupCodes = JSON.stringify(["aaaaa-bbbbb", "ccccc-ddddd"])

let admin: pg.Client
let db: pg.Client
let databaseUrl: string
let userId: string
let sessionCookie: string

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

/** Sign up through Better Auth, which runs with the new secret. */
async function signUp(name: string) {
  const response = await getAuth().handler(
    new Request(`${base}/.auth/api/v1/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        name,
        email: `${name}-${suffix}@example.com`,
        password: "password-1234",
      }),
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  const cookie = response.headers
    .getSetCookie()
    .map((part) => part.split(";")[0])
    .join("; ")
  return { id: body.user.id, cookie }
}

/** Write a row the way the Better Auth two-factor plugin does. */
async function insertTwoFactor(id: string, secret: string, user: string) {
  await db.query(
    "insert into two_factors (id, secret, backup_codes, user_id) values ($1, $2, $3, $4)",
    [
      id,
      await symmetricEncrypt({ key: secret, data: totpSecret }),
      await symmetricEncrypt({ key: secret, data: backupCodes }),
      user,
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
    await runMigrations({
      connectionString: databaseUrl,
      appRolePassword: "role-password-1",
      roleName,
    })
    db = new pg.Client({ connectionString: databaseUrl })
    await db.connect()
    // Better Auth starts on the new secret, as the services do after the roll.
    vi.stubEnv("AUTH_SECRET", newSecret)
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("SMTP_CONNECTION_URL", "")
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    resetBetterAuthForTests()
    // First, so that Better Auth uses this database and not DATABASE_URL.
    initDb(databaseUrl)
    const user = await signUp("reencrypt-one")
    userId = user.id
    sessionCookie = user.cookie
    await insertTwoFactor("tfa_one", oldSecret, userId)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    resetBetterAuthForTests()
    await closeDb()
    await db?.end()
    await admin?.query(`drop database if exists "${database}" with (force)`)
    await admin?.query(`drop role if exists "${roleName}"`)
    await admin?.end()
  })

  it("stops before any change when NEW_AUTH_SECRET is set and OLD_AUTH_SECRET is not", async () => {
    const before = await storedRow("tfa_one")
    const result = run({ NEW_AUTH_SECRET: newSecret }, "--apply")
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      "NEW_AUTH_SECRET is set and OLD_AUTH_SECRET is not",
    )
    expect(result.stderr).not.toContain(newSecret)
    expect(await storedRow("tfa_one")).toEqual(before)
  })

  it("leaves the two-factor rows when NEW_AUTH_SECRET is not set", async () => {
    const before = await storedRow("tfa_one")
    const result = run({ OLD_AUTH_SECRET: oldSecret }, "--apply")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe("0 connections, 0 sandbox tokens\n")
    expect(await storedRow("tfa_one")).toEqual(before)
  })

  it("stops with the variable name when connection secrets exist and NEW_CONNECTION_SECRETS_ENCRYPTION_KEY is not set", async () => {
    const token = encryptConnectionSecret("ghs_test", {
      AUTH_SECRET: oldSecret,
    } as Env)
    await db.query(
      "insert into workspace_sandbox_git_tokens (sandbox_id, org_id, token_ciphertext, minted_at) values ('sbx_reencrypt', 'org_reencrypt', $1, now())",
      [token],
    )
    const result = run(
      { OLD_AUTH_SECRET: oldSecret, NEW_AUTH_SECRET: newSecret },
      "--apply",
    )
    await db.query(
      "delete from workspace_sandbox_git_tokens where sandbox_id = 'sbx_reencrypt'",
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      "NEW_CONNECTION_SECRETS_ENCRYPTION_KEY is not set",
    )
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
    const other = await signUp("reencrypt-other")
    await insertTwoFactor(
      "tfa_other_secret",
      "some-other-secret-0123456789abcdef",
      other.id,
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

  it("lets Better Auth on the new secret read the rolled TOTP secret and accept a backup code", async () => {
    const auth = getAuth()
    const headers = new Headers({ cookie: sessionCookie })
    // A code that does not match fails as an invalid code only after Better
    // Auth decrypts the TOTP secret with the new secret. A secret it cannot
    // decrypt fails with another error. A matching code is not used: Better
    // Auth then writes a two_factors.verified column that this schema does
    // not have.
    const { code } = await auth.api.generateTOTP({
      body: { secret: totpSecret },
    })
    await expect(
      auth.api.verifyTOTP({
        headers,
        body: { code: code === "000000" ? "111111" : "000000" },
      }),
    ).rejects.toThrow("Invalid code")
    const viewed = await auth.api.viewBackupCodes({ body: { userId } })
    expect(viewed.backupCodes).toEqual(JSON.parse(backupCodes))
    const verified = await auth.api.verifyBackupCode({
      headers,
      body: { code: "aaaaa-bbbbb", disableSession: true },
    })
    expect(verified.user.id).toBe(userId)
  })
})
