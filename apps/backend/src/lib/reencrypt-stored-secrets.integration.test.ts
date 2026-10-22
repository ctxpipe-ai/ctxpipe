import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Env, parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { members, organizations, twoFactors, users } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { sandboxGitTokenStore } from "../models/sandbox-git-tokens.js"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "./connection-secrets.js"
import { reencryptStoredSecrets } from "./reencrypt-stored-secrets.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

// An operator rolls AUTH_SECRET and sets an explicit key for the first time.
// Values that the old AUTH_SECRET encrypted must read before and after the
// re-encrypt command, and an unknown key must fail without its value.

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_reencrypt_${suffix}`
const userId = `user_test_reencrypt_${suffix}`
const githubId = `con_test_reencrypt_gh_${suffix}`
const strayId = `con_test_reencrypt_stray_${suffix}`
const sandboxId = `sandbox-reencrypt-${suffix}`
const twoFactorId = `tfa_test_reencrypt_${suffix}`

const oldAuthSecret = randomBytes(32).toString("hex")
const newAuthSecret = randomBytes(32).toString("hex")
const newKey = randomBytes(32).toString("hex")
const privateKey = `pem-${suffix}`
const webhookSecret = `whsec-${suffix}`
const strayValue = `stray-${suffix}`
const gitToken = `ghs_${suffix}`
const totpSecret = `totp-${suffix}`
const backupCodes = JSON.stringify([`code-${suffix}`])

let base: Env
let oldEnv: Env
let rollingEnv: Env
let newOnlyEnv: Env

async function storedConfig(id: string): Promise<Record<string, unknown>> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(eq(connections.id, id)),
  )
  if (!row) throw new Error(`connection ${id} is missing`)
  return row.config
}

async function storedTwoFactor() {
  const [row] = await getSystemDb()
    .select()
    .from(twoFactors)
    .where(eq(twoFactors.id, twoFactorId))
  if (!row) throw new Error("two-factor row is missing")
  return row
}

describe("connector secret key rotation (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    base = parseEnv(process.env)
    oldEnv = {
      ...base,
      AUTH_SECRET: oldAuthSecret,
      CONNECTION_SECRETS_ENCRYPTION_KEY: undefined,
      CONNECTION_SECRETS_PREVIOUS_KEYS: undefined,
    }
    rollingEnv = {
      ...base,
      AUTH_SECRET: newAuthSecret,
      CONNECTION_SECRETS_ENCRYPTION_KEY: newKey,
      CONNECTION_SECRETS_PREVIOUS_KEYS: `auth-secret:${oldAuthSecret}`,
    }
    newOnlyEnv = { ...rollingEnv, CONNECTION_SECRETS_PREVIOUS_KEYS: undefined }

    const db = getSystemDb()
    await db.insert(organizations).values({
      id: orgId,
      name: `Reencrypt ${suffix}`,
      slug: `reencrypt-${suffix}`,
      createdAt: new Date(),
    })
    await db.insert(users).values({
      id: userId,
      name: "Reencrypt test",
      email: `reencrypt-${suffix}@example.com`,
      twoFactorEnabled: true,
    })
    await db.insert(members).values({
      id: `member_test_reencrypt_${suffix}`,
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    })
    await db.insert(twoFactors).values({
      id: twoFactorId,
      userId,
      secret: await symmetricEncrypt({ key: oldAuthSecret, data: totpSecret }),
      backupCodes: await symmetricEncrypt({
        key: oldAuthSecret,
        data: backupCodes,
      }),
    })
    const unknownKeyEnv = {
      ...base,
      CONNECTION_SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    }
    await withOrgDbContext(orgId, (tx) =>
      tx.insert(connections).values([
        {
          id: githubId,
          orgId,
          type: "github",
          config: {
            ingestAllRepositories: true,
            includeFutureRepos: true,
            privateKeyEnc: encryptConnectionSecret(privateKey, oldEnv),
            webhookSecretEnc: encryptConnectionSecret(webhookSecret, oldEnv),
          },
        },
        {
          id: strayId,
          orgId,
          type: "github",
          config: {
            ingestAllRepositories: true,
            includeFutureRepos: true,
            privateKeyEnc: encryptConnectionSecret(strayValue, unknownKeyEnv),
          },
        },
      ]),
    )
    await sandboxGitTokenStore(orgId, oldEnv).put(sandboxId, gitToken)
  })

  afterAll(async () => {
    const db = getSystemDb()
    await withOrgDbContext(orgId, (tx) =>
      tx.delete(connections).where(eq(connections.orgId, orgId)),
    )
    await sandboxGitTokenStore(orgId, rollingEnv)
      .take(sandboxId)
      .catch(() => null)
    await db.delete(users).where(eq(users.id, userId))
    await db.delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  it("reads old values with the previous key, rewrites them to the new key, and names an unknown key without its value", async () => {
    const before = await storedConfig(githubId)
    expect(
      decryptConnectionSecret(String(before.privateKeyEnc), rollingEnv),
    ).toBe(privateKey)
    expect(
      await sandboxGitTokenStore(orgId, rollingEnv).get(sandboxId),
    ).toMatchObject({ token: gitToken })
    expect(() =>
      decryptConnectionSecret(String(before.privateKeyEnc), newOnlyEnv),
    ).toThrow(/CONNECTION_SECRETS_PREVIOUS_KEYS/)

    const dryRun = await reencryptStoredSecrets({
      env: rollingEnv,
      dryRun: true,
      orgId,
    })
    expect(dryRun.connections).toMatchObject({
      rewritten: 2,
      alreadyCurrent: 0,
    })
    expect(await storedConfig(githubId)).toEqual(before)

    const report = await reencryptStoredSecrets({
      env: rollingEnv,
      dryRun: false,
      orgId,
    })
    expect(report).toEqual({
      dryRun: false,
      connections: {
        rewritten: 2,
        alreadyCurrent: 0,
        failed: [`${strayId}.privateKeyEnc`],
      },
      sandboxGitTokens: { rewritten: 1, alreadyCurrent: 0, failed: [] },
      twoFactors: { rewritten: 1, alreadyCurrent: 0, failed: [] },
    })
    expect(JSON.stringify(report)).not.toContain(strayValue)

    const after = await storedConfig(githubId)
    expect(
      decryptConnectionSecret(String(after.privateKeyEnc), newOnlyEnv),
    ).toBe(privateKey)
    expect(
      decryptConnectionSecret(String(after.webhookSecretEnc), newOnlyEnv),
    ).toBe(webhookSecret)
    expect(
      await sandboxGitTokenStore(orgId, newOnlyEnv).get(sandboxId),
    ).toMatchObject({ token: gitToken })
    const twoFactor = await storedTwoFactor()
    expect(
      await symmetricDecrypt({ key: newAuthSecret, data: twoFactor.secret }),
    ).toBe(totpSecret)
    expect(
      await symmetricDecrypt({
        key: newAuthSecret,
        data: twoFactor.backupCodes,
      }),
    ).toBe(backupCodes)

    const stray = await storedConfig(strayId)
    let strayError: unknown
    try {
      decryptConnectionSecret(String(stray.privateKeyEnc), rollingEnv)
    } catch (error) {
      strayError = error
    }
    expect(strayError).toBeInstanceOf(Error)
    expect(String(strayError)).toMatch(/No configured key decrypts/)
    expect(String(strayError)).not.toContain(strayValue)

    const again = await reencryptStoredSecrets({
      env: rollingEnv,
      dryRun: false,
      orgId,
    })
    expect(again.connections).toMatchObject({ rewritten: 0, alreadyCurrent: 2 })
    expect(again.sandboxGitTokens).toMatchObject({
      rewritten: 0,
      alreadyCurrent: 1,
    })
    expect(again.twoFactors).toMatchObject({ rewritten: 0, alreadyCurrent: 1 })
  })
})
