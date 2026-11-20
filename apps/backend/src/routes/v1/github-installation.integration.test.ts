import { createHash, generateKeyPairSync } from "node:crypto"

import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq, like } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, initDb } from "../../db/client.js"
import { accounts, verifications } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { generateObjectId } from "../../lib/id.js"
import {
  createDraftGithubConnection,
  createPlaceholderGithubConnection,
  deleteGithubConnectionById,
  listGithubConnectionsForOrg,
} from "../../models/github-installation.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerAuthRoutes } from "../auth.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

const installationId = 424_242
const ownAppInstallationId = 515_151
const visibleToken = "gho_can_see_installation"
const otherToken = "gho_cannot_see_installation"
const revokedToken = "gho_revoked"
const oauthAppToken = "gho_oauth_app"
// One-time App authorization: each code gives one user token.
const tokenForCode: Record<string, string> = {
  "code-visible": visibleToken,
  "code-other": otherToken,
}
const authorizedGithubUser = { id: 4242, login: "octo-owner" }
const { privateKey: ownAppPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

let installationLookups = 0
let codeExchanges: Record<string, string>[] = []

useMswServer(
  http.get("https://api.github.com/user/installations", ({ request }) => {
    installationLookups += 1
    const auth = request.headers.get("authorization") ?? ""
    if (auth.endsWith(revokedToken)) {
      return HttpResponse.json({ message: "Bad credentials" }, { status: 401 })
    }
    if (auth.endsWith(oauthAppToken)) {
      return HttpResponse.json({ message: "Forbidden" }, { status: 403 })
    }
    const installations = auth.endsWith(visibleToken)
      ? [{ id: installationId }]
      : [{ id: 1 }]
    return HttpResponse.json({
      total_count: installations.length,
      installations,
    })
  }),
  // The own App's installation, asked with its JWT.
  http.get(
    "https://api.github.com/app/installations/:installationId",
    ({ params }) =>
      Number(params.installationId) === ownAppInstallationId
        ? HttpResponse.json({ id: ownAppInstallationId, account: null })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
  // Account-slug refresh after attaching; not under test here.
  http.post(
    "https://api.github.com/app/installations/:installationId/access_tokens",
    () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
  http.post(
    "https://github.com/login/oauth/access_token",
    async ({ request }) => {
      // The App authorization sends JSON; Better Auth's refresh sends a form.
      if (request.headers.get("content-type")?.includes("json")) {
        const body = (await request.json()) as Record<string, string>
        codeExchanges.push(body)
        const token = body.code ? tokenForCode[body.code] : undefined
        return token
          ? HttpResponse.json({ access_token: token, token_type: "bearer" })
          : HttpResponse.json({ error: "bad_verification_code" })
      }
      return HttpResponse.json({
        access_token: visibleToken,
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: "ghr_rotated",
      })
    },
  ),
  http.get("https://api.github.com/user", () =>
    HttpResponse.json(authorizedGithubUser),
  ),
  // Better Auth dashboard events when a local .env.local enables them.
  http.post(
    "https://dash.better-auth.com/*",
    () => new HttpResponse(null, { status: 204 }),
  ),
)

describe("POST /github/installation requires GitHub access (Postgres)", () => {
  let seed: SeededOrg
  // The deployment App is "3", with no key: a stored copy of App "3" is the
  // deployment App, and nothing here may reach GitHub as the App.
  const env = parseEnv({
    ...(process.env as Record<string, string | undefined>),
    GITHUB_APP_ID: "3",
    GITHUB_PRIVATE_KEY: undefined,
    GITHUB_CLIENT_ID: "test-github-client",
    GITHUB_CLIENT_SECRET: "test-github-secret",
  })

  function createApp(appEnv = env) {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use(evlog())
    app.use(withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("env", appEnv)
      c.set("user", null)
      c.set("session", null)
      c.set("oauthReferenceId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    // The same order as the app: the auth routes come first.
    registerAuthRoutes(app)
    registerV1Routes(app)
    return app
  }

  function attach(
    body: { installationId: number; connectionId?: string },
    app = createApp(),
  ) {
    return app.request(
      `http://backend.test/${seed.orgSlug}/api/v1/github/installation`,
      {
        method: "POST",
        headers: { cookie: seed.cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    )
  }

  async function linkGithub(
    accessToken: string,
    refresh?: { refreshToken: string; accessTokenExpiresAt: Date },
    userId = seed.userId,
    accountId = `gh-${userId}`,
  ) {
    await getSystemDb()
      .insert(accounts)
      .values({
        id: generateObjectId("acc"),
        accountId,
        providerId: "github",
        userId,
        accessToken,
        ...refresh,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
  }

  function createOwnAppDraft() {
    return createDraftGithubConnection({
      orgId: seed.orgId,
      env,
      githubAppId: "1",
      appSlug: "self-hosted-app",
      privateKey: ownAppPrivateKey,
      webhookSecret: "webhook-secret",
    })
  }

  /** The attach refusal that sends the user to authorize the App once. */
  async function authorizeUrlFor(body: {
    installationId: number
    connectionId?: string
  }) {
    const res = await attach(body)
    expect(res.status).toBe(403)
    const json = (await res.json()) as { why?: string; authorizeUrl?: string }
    expect(json.why).toBe("github_authorization_required")
    return new URL(json.authorizeUrl ?? "")
  }

  /** GitHub's redirect back after the user authorizes the App. */
  function githubCallback(
    state: string,
    code: string,
    cookie: string = seed.cookie,
  ) {
    return createApp().request(
      `http://backend.test/.auth/api/v1/auth/callback/github?${new URLSearchParams({ code, state })}`,
      { headers: { cookie } },
    )
  }

  function expectProofRefused(res: Response) {
    expect(res.status).toBe(302)
    expect(
      new URL(res.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("github_installation_proof_failed")
  }

  async function attachedInstallationIds() {
    const rows = await listGithubConnectionsForOrg(seed.orgId)
    return rows.map((row) => row.installationId)
  }

  let other: SeededOrg

  beforeAll(async () => {
    // GitHub sign-in configured, so Better Auth can refresh GitHub tokens.
    vi.stubEnv("GITHUB_CLIENT_ID", "test-github-client")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-secret")
    seed = await seedOrg()
    other = await seedOrg()
  })

  afterEach(async () => {
    vi.useRealTimers()
    installationLookups = 0
    codeExchanges = []
    for (const userId of [seed.userId, other.userId]) {
      await getSystemDb()
        .delete(accounts)
        .where(
          and(eq(accounts.userId, userId), eq(accounts.providerId, "github")),
        )
    }
    await getSystemDb()
      .delete(verifications)
      .where(like(verifications.identifier, "github-installation-proof:%"))
    for (const row of await listGithubConnectionsForOrg(seed.orgId)) {
      await deleteGithubConnectionById(seed.orgId, row.id)
    }
  })

  afterAll(async () => {
    for (const s of [other, seed]) {
      if (!s) continue
      // cleanupSeededOrg closes the pool, so open it again for the next seed.
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(s)
    }
    vi.unstubAllEnvs()
  })

  it("asks a user without a linked GitHub account to authorize the App once, and writes nothing", async () => {
    const url = await authorizeUrlFor({ installationId })

    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    )
    expect(url.searchParams.get("client_id")).toBe("test-github-client")
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${env.AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`,
    )
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(await attachedInstallationIds()).toEqual([])
  })

  it("says that the deployment cannot ask GitHub when it has no GitHub App client", async () => {
    const res = await attach(
      { installationId },
      createApp({
        ...env,
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
      }),
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      why: "github_authorization_unavailable",
    })
    expect(await attachedInstallationIds()).toEqual([])
  })

  it("rejects attaching to a placeholder connection without a linked GitHub account", async () => {
    const placeholder = await createPlaceholderGithubConnection({
      orgId: seed.orgId,
    })

    const res = await attach({ installationId, connectionId: placeholder.id })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      why: "github_authorization_required",
    })
    expect(await attachedInstallationIds()).toEqual([null])
  })

  it("asks to authorize the App when the linked GitHub account cannot see the installation", async () => {
    await linkGithub(otherToken)

    await authorizeUrlFor({ installationId })

    expect(await attachedInstallationIds()).toEqual([])
  })

  it.each([
    ["rejects the stored token", revokedToken],
    ["will not list installations for the token", oauthAppToken],
  ])("asks to authorize the App when GitHub %s", async (_, token) => {
    await linkGithub(token)

    await authorizeUrlFor({ installationId })

    expect(await attachedInstallationIds()).toEqual([])
  })

  it("attaches the installation when the GitHub account can see it", async () => {
    await linkGithub(visibleToken)

    const res = await attach({ installationId })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ installationId })
    expect(await attachedInstallationIds()).toEqual([installationId])
    expect(installationLookups).toBe(1)
  })

  it("refreshes an expired GitHub token before checking access", async () => {
    await linkGithub("gho_expired", {
      refreshToken: "ghr_refresh",
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    })

    const res = await attach({ installationId })

    expect(res.status).toBe(200)
    expect(await attachedInstallationIds()).toEqual([installationId])
  })

  it("attaches to a connection whose own App owns the installation, without a GitHub account", async () => {
    const draft = await createOwnAppDraft()

    const res = await attach({
      installationId: ownAppInstallationId,
      connectionId: draft.id,
    })

    expect(res.status).toBe(200)
    expect(await attachedInstallationIds()).toEqual([ownAppInstallationId])
    expect(installationLookups).toBe(0)
  })

  it("requires a GitHub account to attach to a connection that stores the deployment App's credentials", async () => {
    const copy = await createDraftGithubConnection({
      orgId: seed.orgId,
      env,
      githubAppId: "3",
      appSlug: "ctxpipe-agent",
      privateKey: ownAppPrivateKey,
      webhookSecret: "webhook-secret",
    })

    const res = await attach({
      installationId: ownAppInstallationId,
      connectionId: copy.id,
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      why: "github_authorization_required",
    })
    expect(await attachedInstallationIds()).toEqual([null])
  })

  it("rejects attaching another App's installation to a connection with its own App", async () => {
    const draft = await createOwnAppDraft()

    const res = await attach({ installationId, connectionId: draft.id })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      why: "github_installation_not_accessible",
    })
    expect(await attachedInstallationIds()).toEqual([null])
  })

  describe("one-time GitHub App authorization", () => {
    it("attaches the installation, makes no account link and stores no token", async () => {
      const url = await authorizeUrlFor({ installationId })
      const state = url.searchParams.get("state") ?? ""

      const res = await githubCallback(state, "code-visible")

      expect(res.status).toBe(302)
      expect(new URL(res.headers.get("location") ?? "").pathname).toBe(
        `/${seed.orgSlug}/github/setup`,
      )
      expect(await attachedInstallationIds()).toEqual([installationId])
      // The code exchange proves the PKCE verifier of this state.
      expect(codeExchanges).toHaveLength(1)
      const [exchange] = codeExchanges
      expect(exchange).toMatchObject({
        client_id: "test-github-client",
        client_secret: "test-github-secret",
        code: "code-visible",
        redirect_uri: `${env.AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`,
      })
      expect(
        createHash("sha256")
          .update(exchange?.code_verifier ?? "")
          .digest("base64url"),
      ).toBe(url.searchParams.get("code_challenge"))
      const links = await getSystemDb()
        .select()
        .from(accounts)
        .where(eq(accounts.userId, seed.userId))
      expect(links.filter((a) => a.providerId === "github")).toEqual([])
      const stored = JSON.stringify([
        await getSystemDb()
          .select()
          .from(connections)
          .where(eq(connections.orgId, seed.orgId)),
        await getSystemDb().select().from(verifications),
        links,
      ])
      expect(stored).not.toContain(visibleToken)
    })

    it("goes through the OAuth forwarder of the deployment, when it has one", async () => {
      // The AWS PR previews (CTX-1426): the forwarder gives the state back
      // as this deployment sent it.
      const forwarded = createApp({
        ...env,
        GITHUB_AUTHORIZE_URL:
          "https://forwarder.example.test/github/authorize/pr-12",
        GITHUB_REDIRECT_URI: "https://forwarder.example.test/github/callback",
      })
      const res = await attach({ installationId }, forwarded)
      expect(res.status).toBe(403)
      const url = new URL(
        ((await res.json()) as { authorizeUrl?: string }).authorizeUrl ?? "",
      )
      expect(url.origin + url.pathname).toBe(
        "https://forwarder.example.test/github/authorize/pr-12",
      )
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://forwarder.example.test/github/callback",
      )
      // The UI sends the user only to the authorize page that the deployment
      // names.
      const config = await forwarded.request(
        "http://backend.test/.auth/api/config",
      )
      expect(
        ((await config.json()) as { githubAuthorizeUrl?: string })
          .githubAuthorizeUrl,
      ).toBe("https://forwarder.example.test/github/authorize/pr-12")

      const done = await forwarded.request(
        `http://backend.test/.auth/api/v1/auth/callback/github?${new URLSearchParams({ code: "code-visible", state: url.searchParams.get("state") ?? "" })}`,
        { headers: { cookie: seed.cookie } },
      )

      expect(new URL(done.headers.get("location") ?? "").pathname).toBe(
        `/${seed.orgSlug}/github/setup`,
      )
      expect(codeExchanges).toHaveLength(1)
      expect(codeExchanges[0]?.redirect_uri).toBe(
        "https://forwarder.example.test/github/callback",
      )
    })

    it("attaches for a user whose GitHub account is linked to another ctxpipe user", async () => {
      await linkGithub(
        "gho_link_of_other_user",
        undefined,
        other.userId,
        String(authorizedGithubUser.id),
      )
      const url = await authorizeUrlFor({ installationId })

      const res = await githubCallback(
        url.searchParams.get("state") ?? "",
        "code-visible",
      )

      expect(res.status).toBe(302)
      expect(await attachedInstallationIds()).toEqual([installationId])
      const githubLinks = await getSystemDb()
        .select({ userId: accounts.userId, accessToken: accounts.accessToken })
        .from(accounts)
        .where(
          and(
            eq(accounts.providerId, "github"),
            eq(accounts.accountId, String(authorizedGithubUser.id)),
          ),
        )
      expect(githubLinks).toEqual([
        { userId: other.userId, accessToken: "gho_link_of_other_user" },
      ])
    })

    it("refuses when the authorized GitHub account cannot see the installation", async () => {
      const url = await authorizeUrlFor({ installationId })

      const res = await githubCallback(
        url.searchParams.get("state") ?? "",
        "code-other",
      )

      expectProofRefused(res)
      expect(await attachedInstallationIds()).toEqual([])
    })

    it("refuses a state that was used before", async () => {
      const url = await authorizeUrlFor({ installationId })
      const state = url.searchParams.get("state") ?? ""
      expect((await githubCallback(state, "code-visible")).status).toBe(302)
      for (const row of await listGithubConnectionsForOrg(seed.orgId)) {
        await deleteGithubConnectionById(seed.orgId, row.id)
      }

      const res = await githubCallback(state, "code-visible")

      expectProofRefused(res)
      expect(await attachedInstallationIds()).toEqual([])
      expect(codeExchanges).toHaveLength(1)
    })

    it("refuses a state that the server did not issue", async () => {
      const url = await authorizeUrlFor({ installationId })
      const state = url.searchParams.get("state") ?? ""
      const forged = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`

      const res = await githubCallback(forged, "code-visible")

      expectProofRefused(res)
      expect(await attachedInstallationIds()).toEqual([])
      expect(codeExchanges).toEqual([])
    })

    it("refuses a state after it expires", async () => {
      const url = await authorizeUrlFor({ installationId })
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(Date.now() + 11 * 60 * 1000)

      const res = await githubCallback(
        url.searchParams.get("state") ?? "",
        "code-visible",
      )

      expectProofRefused(res)
      expect(await attachedInstallationIds()).toEqual([])
      expect(codeExchanges).toEqual([])
    })

    it("refuses a state that another ctxpipe user started", async () => {
      const url = await authorizeUrlFor({ installationId })

      const res = await githubCallback(
        url.searchParams.get("state") ?? "",
        "code-visible",
        other.cookie,
      )

      expectProofRefused(res)
      expect(await attachedInstallationIds()).toEqual([])
      expect(codeExchanges).toEqual([])
    })
  })
})
