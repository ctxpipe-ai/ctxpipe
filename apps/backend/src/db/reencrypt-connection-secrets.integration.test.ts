import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
} from "../lib/connection-secrets.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { reencryptConnectionSecrets } from "./reencrypt-connection-secrets.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_reencrypt_${suffix}`
const connectionId = `con_test_reencrypt_${suffix}`
const brokenConnectionId = `con_test_reencrypt_broken_${suffix}`
const sandboxId = `sandbox-reencrypt-${suffix}`

const oldKey = {
  AUTH_SECRET: "old-auth-secret-of-at-least-32-characters",
  CONNECTION_SECRETS_ENCRYPTION_KEY: undefined,
}
const newKey = {
  AUTH_SECRET: "",
  CONNECTION_SECRETS_ENCRYPTION_KEY: "ab".repeat(32),
}
const otherKey = {
  AUTH_SECRET: "",
  CONNECTION_SECRETS_ENCRYPTION_KEY: "cd".repeat(32),
}

let pool: Pool

async function readRows() {
  const connection = await pool.query<{ config: Record<string, unknown> }>(
    "select config from connections where id = $1",
    [connectionId],
  )
  const token = await pool.query<{ token_ciphertext: string }>(
    "select token_ciphertext from workspace_sandbox_git_tokens where sandbox_id = $1",
    [sandboxId],
  )
  return {
    config: connection.rows[0]?.config as {
      installationId: string
      accessTokenEnc: string
      apps: { webhookSecretEnc: string }[]
    },
    token: token.rows[0]?.token_ciphertext ?? "",
  }
}

async function run(apply: boolean) {
  const client = await pool.connect()
  try {
    return await reencryptConnectionSecrets({
      client,
      from: oldKey,
      to: newKey,
      apply,
      orgId,
    })
  } finally {
    client.release()
  }
}

describe("reencryptConnectionSecrets (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    pool = new Pool({
      connectionString: ownerUrlForMigrate(process.env.DATABASE_URL),
    })
    await pool.query(
      "insert into organizations (id, name, slug, created_at) values ($1, $1, $1, now())",
      [orgId],
    )
    await pool.query(
      "insert into connections (id, org_id, type, config) values ($1, $2, 'linear', $3::jsonb)",
      [
        connectionId,
        orgId,
        JSON.stringify({
          installationId: "not-a-secret",
          accessTokenEnc: encryptConnectionSecret("lin_access", oldKey),
          apps: [
            { webhookSecretEnc: encryptConnectionSecret("whsec", oldKey) },
          ],
        }),
      ],
    )
    await pool.query(
      "insert into workspace_sandbox_git_tokens (sandbox_id, org_id, token_ciphertext, minted_at) values ($1, $2, $3, now())",
      [sandboxId, orgId, encryptConnectionSecret("ghs_token", oldKey)],
    )
  })

  afterAll(async () => {
    await pool.query(
      "delete from workspace_sandbox_git_tokens where org_id = $1",
      [orgId],
    )
    await pool.query("delete from organizations where id = $1", [orgId])
    await pool.end()
  })

  it("rolls back a dry run", async () => {
    const before = await readRows()
    const report = await run(false)
    expect(report).toEqual({
      applied: false,
      connections: { rows: 1, rotated: 2, alreadyNewKey: 0 },
      sandboxGitTokens: { rows: 1, rotated: 1, alreadyNewKey: 0 },
    })
    expect(await readRows()).toEqual(before)
  })

  it("moves each secret to the new key, and a second run does nothing", async () => {
    await run(true)
    const after = await readRows()
    expect(after.config.installationId).toBe("not-a-secret")
    expect(decryptConnectionSecret(after.config.accessTokenEnc, newKey)).toBe(
      "lin_access",
    )
    const webhookSecretEnc = after.config.apps[0]?.webhookSecretEnc ?? ""
    expect(decryptConnectionSecret(webhookSecretEnc, newKey)).toBe("whsec")
    expect(decryptConnectionSecret(after.token, newKey)).toBe("ghs_token")

    expect(await run(true)).toEqual({
      applied: true,
      connections: { rows: 0, rotated: 0, alreadyNewKey: 2 },
      sandboxGitTokens: { rows: 0, rotated: 0, alreadyNewKey: 1 },
    })
    expect(await readRows()).toEqual(after)
  })

  it("changes nothing and names the location when a value decrypts with neither key", async () => {
    await pool.query(
      "insert into connections (id, org_id, type, config) values ($1, $2, 'notion', $3::jsonb)",
      [
        brokenConnectionId,
        orgId,
        JSON.stringify({
          accessTokenEnc: encryptConnectionSecret("x", otherKey),
        }),
      ],
    )
    await pool.query(
      "update workspace_sandbox_git_tokens set token_ciphertext = $2 where sandbox_id = $1",
      [sandboxId, encryptConnectionSecret("ghs_token", oldKey)],
    )
    const before = await readRows()
    await expect(run(true)).rejects.toThrow(
      `connections[${brokenConnectionId}].config.accessTokenEnc`,
    )
    expect(await readRows()).toEqual(before)
  })

  it("refuses the same key as old and new", async () => {
    const client = await pool.connect()
    try {
      await expect(
        reencryptConnectionSecrets({
          client,
          from: newKey,
          to: newKey,
          apply: true,
          orgId,
        }),
      ).rejects.toThrow("same key")
    } finally {
      client.release()
    }
  })
})
