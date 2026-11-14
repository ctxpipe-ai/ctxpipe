import { createVerify, generateKeyPairSync } from "node:crypto"

import { HttpResponse, http } from "msw"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { useMswServer } from "../../test/msw.js"
import { type Env, parseEnv } from "../config/env.js"
import { closeDb, initDb } from "../db/client.js"
import { ownerUrlForMigrate } from "../db/owner-migrate-url.js"
import { runMigrations } from "../db/run-migrations.js"
import { encryptConnectionSecret } from "./connection-secrets.js"
import { validateTargetSecrets } from "./validate-target-secrets.js"

/*
 * The secret checks with the target's real data path: a database of this run
 * (the check reads every connection), the app role under row-level security,
 * and GitHub's App endpoints in MSW, which verify the App's JWT with the
 * App's public key, as GitHub does.
 */

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const database = `ctxpipe_test_validate_secrets_${suffix}`
const roleName = `ctxpipe_app_validate_secrets_${suffix}`
const rolePassword = "role-password-validate-secrets"
const productionKey = "a".repeat(64)
const otherKey = "b".repeat(64)
const appId = "4242"
const installationId = 77
const installationToken = "ghs_test_installation_token"

const githubKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
const otherGithubKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = (pair: typeof githubKey) =>
  pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString()

let revoked = 0

/** True when the request carries a JWT of this App, signed with its key. */
function signedByApp(request: Request): boolean {
  const jwt = request.headers.get("authorization")?.replace(/^bearer /i, "")
  const [header, payload, signature] = jwt?.split(".") ?? []
  if (!header || !payload || !signature) return false
  const verify = createVerify("RSA-SHA256")
  verify.update(`${header}.${payload}`)
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    iss?: unknown
  }
  return (
    verify.verify(githubKey.publicKey, signature, "base64url") &&
    String(claims.iss) === appId
  )
}

const badCredentials = () =>
  HttpResponse.json(
    { message: "A JSON web token could not be decoded" },
    { status: 401 },
  )

useMswServer(
  http.get("https://api.github.com/app/installations", ({ request }) =>
    signedByApp(request)
      ? // GitHub refuses a token for the suspended one: no handler mints it.
        HttpResponse.json([
          { id: installationId - 1, suspended_at: "2026-01-01T00:00:00Z" },
          { id: installationId, suspended_at: null },
        ])
      : badCredentials(),
  ),
  http.post(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    ({ request }) =>
      signedByApp(request)
        ? HttpResponse.json(
            { token: installationToken, expires_at: "2099-01-01T00:00:00Z" },
            { status: 201 },
          )
        : badCredentials(),
  ),
  http.delete("https://api.github.com/installation/token", ({ request }) => {
    if (request.headers.get("authorization") !== `token ${installationToken}`)
      return badCredentials()
    revoked += 1
    return new HttpResponse(null, { status: 204 })
  }),
)

let admin: pg.Client
let owner: pg.Client

function targetEnv(overrides: Partial<Env>): Env {
  return {
    ...parseEnv({
      DATABASE_URL: "postgresql://unused@localhost/unused",
      AUTH_SECRET: "auth-secret-of-the-validate-secrets-test",
      AUTH_BASE_URL: "https://target.test",
      GITHUB_APP_ID: appId,
      GITHUB_PRIVATE_KEY: pem(githubKey),
    }),
    CONNECTION_SECRETS_ENCRYPTION_KEY: productionKey,
    ...overrides,
  }
}

describe("validateTargetSecrets", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    await admin.query(`create database "${database}"`)
    ownerUrl.pathname = `/${database}`
    await runMigrations({
      connectionString: ownerUrl.toString(),
      appRolePassword: rolePassword,
      roleName,
    })
    owner = new pg.Client({ connectionString: ownerUrl.toString() })
    await owner.connect()
    // Two organizations, each with a connector whose config holds secrets
    // that production's key encrypted, as in the copied database.
    const env = targetEnv({})
    for (const n of [1, 2]) {
      await owner.query(
        "insert into organizations (id, name, slug, created_at) values ($1, $1, $1, now())",
        [`org_validate_${n}`],
      )
      const config = {
        workspaceId: `lin_${n}`,
        accessToken: encryptConnectionSecret(`access-${n}`, env),
        nested: { refreshToken: encryptConnectionSecret(`refresh-${n}`, env) },
      }
      await owner.query(
        "insert into connections (id, org_id, type, config) values ($1, $2, 'linear', $3)",
        [`con_validate_${n}`, `org_validate_${n}`, config],
      )
      await owner.query(
        "insert into connection_directory (connection_id, org_id, type, linear_workspace_id) values ($1, $2, 'linear', $3)",
        [`con_validate_${n}`, `org_validate_${n}`, `lin_${n}`],
      )
    }
    // The app role, as the backend task logs in: row-level security applies.
    const appUrl = new URL(ownerUrl)
    appUrl.username = roleName
    appUrl.password = rolePassword
    initDb(appUrl.toString())
  })

  afterAll(async () => {
    await closeDb()
    await owner?.end()
    await admin?.query(`drop database if exists "${database}" with (force)`)
    await admin?.query(`drop role if exists "${roleName}"`)
    await admin?.end()
  })

  it("passes with production's key and the App's own key, and revokes the token", async () => {
    const results = await validateTargetSecrets(targetEnv({}))

    expect(results).toEqual([
      {
        name: "connection secrets decrypt",
        ok: true,
        detail: "4 stored secrets decrypt",
      },
      {
        name: "github installation token",
        ok: true,
        detail: `App ${appId}: an installation token was minted and revoked`,
      },
    ])
    expect(revoked).toBe(1)
  })

  it("fails both checks with a new connection key and another App's key, and names no secret", async () => {
    const results = await validateTargetSecrets(
      targetEnv({
        CONNECTION_SECRETS_ENCRYPTION_KEY: otherKey,
        GITHUB_PRIVATE_KEY: pem(otherGithubKey),
      }),
    )

    expect(results.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: "connection secrets decrypt", ok: false },
      { name: "github installation token", ok: false },
    ])
    expect(results[0]?.detail).toContain("4 of 4 stored secrets do not decrypt")
    expect(results[1]?.detail).toContain(
      "A JSON web token could not be decoded",
    )
    const output = JSON.stringify(results)
    for (const secret of [otherKey, "access-1", "org_validate_1"])
      expect(output).not.toContain(secret)
  })

  it("counts an organization whose connections it cannot read, and names no organization", async () => {
    // A failed query: its error holds the organization id as a parameter.
    await owner.query(`revoke select on connections from "${roleName}"`)
    try {
      const [decrypt] = await validateTargetSecrets(targetEnv({}))

      expect(decrypt).toEqual({
        name: "connection secrets decrypt",
        ok: false,
        detail:
          "The connections of 2 organizations could not be read. Run the check again.",
      })
    } finally {
      await owner.query(`grant select on connections to "${roleName}"`)
    }
  })
})
