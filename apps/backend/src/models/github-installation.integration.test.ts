import { generateKeyPairSync } from "node:crypto"

import { and, eq } from "drizzle-orm"
import { importSPKI, jwtVerify } from "jose"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../test/db.js"
import { useMswServer } from "../../test/msw.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { accounts } from "../db/schema/auth.js"
import {
  createDraftGithubConnection,
  getGithubAppInstallationPermissions,
  getGithubUserAccessToken,
  getWebhookSecretForGithubConnection,
  registerInstallationOnConnection,
} from "./github-installation.js"

const deploymentAppId = "2"
const installationId = 616_161

function rsaKeyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
}

// The deployment App's key before and after a rotation. GitHub knows only the
// new key, as after the old key is deleted in the App settings.
const rotatedOut = rsaKeyPair()
const current = rsaKeyPair()

async function signedByCurrentKey(request: Request): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace(/^bearer /i, "")
  if (!token) return false
  try {
    const { payload } = await jwtVerify(
      token,
      await importSPKI(current.publicKey, "RS256"),
    )
    return String(payload.iss) === deploymentAppId
  } catch {
    return false
  }
}

const notDecoded = () =>
  HttpResponse.json(
    { message: "A JSON web token could not be decoded" },
    { status: 401 },
  )

const server = useMswServer(
  http.get(
    "https://api.github.com/app/installations/:installationId",
    async ({ request }) =>
      (await signedByCurrentKey(request))
        ? HttpResponse.json({
            id: installationId,
            account: { login: "octocat" },
            permissions: { contents: "write" },
          })
        : notDecoded(),
  ),
  http.post(
    "https://api.github.com/app/installations/:installationId/access_tokens",
    async ({ request }) =>
      (await signedByCurrentKey(request))
        ? HttpResponse.json(
            {
              token: "ghs_installation",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
            { status: 201 },
          )
        : notDecoded(),
  ),
)

describeWithDatabase(
  "GitHub App credentials after a key rotation (Postgres)",
  () => {
    let seed: SeededOrg
    const env = parseEnv({
      ...(process.env as Record<string, string | undefined>),
      GITHUB_APP_ID: deploymentAppId,
      GITHUB_PRIVATE_KEY: current.privateKey,
      GITHUB_WEBHOOK_SECRET: "current-deployment-webhook-secret",
    })

    beforeAll(async () => {
      seed = await seedOrg()
    })

    afterAll(async () => {
      await cleanupSeededOrg(seed)
    })

    async function connectionStoring(input: {
      githubAppId: string
      privateKey: string
      webhookSecret: string
    }) {
      const row = await createDraftGithubConnection({
        orgId: seed.orgId,
        env,
        appSlug: "ctxpipe-agent",
        ...input,
      })
      await registerInstallationOnConnection({
        orgId: seed.orgId,
        connectionId: row.id,
        installationId,
        env,
      })
      return row
    }

    it("signs with the current deployment key for a connection that stores an old copy of the deployment App", async () => {
      const copy = await connectionStoring({
        githubAppId: deploymentAppId,
        privateKey: rotatedOut.privateKey,
        webhookSecret: "rotated-out-webhook-secret",
      })

      await expect(
        getGithubAppInstallationPermissions(seed.orgId, env, copy.id),
      ).resolves.toEqual({ contents: "write" })
    })

    it("answers a stored copy of the deployment App with the current deployment webhook secret", async () => {
      const copy = await connectionStoring({
        githubAppId: deploymentAppId,
        privateKey: rotatedOut.privateKey,
        webhookSecret: "rotated-out-webhook-secret",
      })

      await expect(
        getWebhookSecretForGithubConnection(copy.id, env),
      ).resolves.toBe("current-deployment-webhook-secret")
    })

    it("keeps the webhook secret of a connection with its own App", async () => {
      const own = await connectionStoring({
        githubAppId: "9",
        privateKey: rsaKeyPair().privateKey,
        webhookSecret: "own-app-webhook-secret",
      })

      await expect(
        getWebhookSecretForGithubConnection(own.id, env),
      ).resolves.toBe("own-app-webhook-secret")
    })
  },
)

describeWithDatabase("GitHub user token of a linked account (Postgres)", () => {
  let seed: SeededOrg

  beforeAll(async () => {
    // Better Auth reads the GitHub sign-in config when the first test makes it.
    vi.stubEnv("GITHUB_CLIENT_ID", "github-client-id")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-client-secret")
    seed = await seedOrg()
  })

  afterAll(async () => {
    await cleanupSeededOrg(seed)
    vi.unstubAllEnvs()
  })

  // Replaces the GitHub account of the seeded user, so each test has one.
  async function linkGithubAccount(
    token: Pick<
      typeof accounts.$inferInsert,
      "accessToken" | "accessTokenExpiresAt" | "refreshToken"
    >,
  ) {
    const db = getSystemDb()
    await db
      .delete(accounts)
      .where(
        and(
          eq(accounts.userId, seed.userId),
          eq(accounts.providerId, "github"),
        ),
      )
    await db.insert(accounts).values({
      id: `acc_github_${seed.userId}`,
      accountId: "583231",
      providerId: "github",
      userId: seed.userId,
      ...token,
    })
  }

  it("returns the stored token of the GitHub account that the user linked", async () => {
    await linkGithubAccount({
      accessToken: "ghu_linked_account",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    })

    await expect(getGithubUserAccessToken(seed.userId)).resolves.toBe(
      "ghu_linked_account",
    )
  })

  it("returns no token when GitHub refuses to refresh an expired token", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "bad_refresh_token" }, { status: 400 }),
      ),
    )
    await linkGithubAccount({
      accessToken: "ghu_expired",
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
      refreshToken: "ghr_revoked",
    })

    await expect(getGithubUserAccessToken(seed.userId)).resolves.toBeUndefined()
  })
})
