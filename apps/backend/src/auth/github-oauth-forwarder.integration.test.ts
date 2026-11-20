import { inArray } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { users } from "../db/schema/auth.js"
import { getAuth, resetBetterAuthForTests } from "./config.js"

// A deployment whose GitHub OAuth flows go through a forwarder (the AWS PR
// previews, CTX-1426): the forwarder serves the authorize step and the one
// callback URL that the GitHub App lists. It gives the state back to this
// deployment as this deployment sent it, so Better Auth's own state check
// still decides.

const base = "http://localhost:3000"
const authPath = `${base}/.auth/api/v1/auth`
const authorizeUrl = "https://forwarder.example.test/github/authorize/pr-12"
const redirectUri = "https://forwarder.example.test/github/callback"
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const githubEmail = `forwarder-github-${suffix}@example.com`

let tokenRequests: URLSearchParams[] = []
const github = setupServer(
  http.post(
    "https://github.com/login/oauth/access_token",
    async ({ request }) => {
      tokenRequests.push(new URLSearchParams(await request.text()))
      return HttpResponse.json({
        access_token: "gho_test",
        token_type: "bearer",
        scope: "read:user,user:email",
      })
    },
  ),
  http.get("https://api.github.com/user", () =>
    HttpResponse.json({
      id: Number.parseInt(suffix.slice(-6), 36),
      login: `forwarder-${suffix}`,
      name: "Forwarder test",
      email: githubEmail,
      avatar_url: null,
    }),
  ),
  http.get("https://api.github.com/user/emails", () =>
    HttpResponse.json([
      { email: githubEmail, primary: true, verified: true, visibility: null },
    ]),
  ),
  // Better Auth dashboard events when a local .env.local enables them.
  http.post(
    "https://dash.better-auth.com/*",
    () => new HttpResponse(null, { status: 204 }),
  ),
)

function cookiePairs(response: Response): string[] {
  return response.headers.getSetCookie().map((part) => part.split(";")[0] ?? "")
}

async function startSignIn() {
  const started = await getAuth().handler(
    new Request(`${authPath}/sign-in/social`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: `${base}/` }),
    }),
  )
  expect(started.status).toBe(200)
  const { url } = (await started.json()) as { url: string }
  return { url: new URL(url), cookie: cookiePairs(started).join("; ") }
}

function callback(state: string, cookie: string) {
  return getAuth().handler(
    new Request(
      `${authPath}/callback/github?${new URLSearchParams({ code: "test-code", state })}`,
      { headers: { cookie } },
    ),
  )
}

describe("GitHub sign-in through an OAuth forwarder (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is unset: this test needs Postgres")
    }
    initDb(process.env.DATABASE_URL)
    github.listen({ onUnhandledRequest: "bypass" })
  })

  beforeEach(() => {
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("SMTP_CONNECTION_URL", "")
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("GITHUB_CLIENT_ID", "forwarder-client")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "forwarder-client-secret")
    vi.stubEnv("GITHUB_AUTHORIZE_URL", authorizeUrl)
    vi.stubEnv("GITHUB_REDIRECT_URI", redirectUri)
    resetBetterAuthForTests()
  })

  afterEach(() => {
    tokenRequests = []
    vi.unstubAllEnvs()
    resetBetterAuthForTests()
  })

  afterAll(async () => {
    github.close()
    await getSystemDb()
      .delete(users)
      .where(inArray(users.email, [githubEmail]))
    await closeDb()
  })

  it("starts at the forwarder's authorize URL, with the forwarder's callback as the redirect URI", async () => {
    const { url } = await startSignIn()

    expect(url.origin + url.pathname).toBe(authorizeUrl)
    expect(url.searchParams.get("client_id")).toBe("forwarder-client")
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri)
    expect(url.searchParams.get("state")).toBeTruthy()
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })

  it("signs in when the forwarder brings the state back, and sends the same redirect URI to GitHub", async () => {
    const { url, cookie } = await startSignIn()

    const res = await callback(url.searchParams.get("state") ?? "", cookie)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`${base}/`)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]?.get("redirect_uri")).toBe(redirectUri)
    const session = await getAuth().handler(
      new Request(`${authPath}/get-session`, {
        headers: {
          cookie: cookiePairs(res)
            .filter((p) => p.includes("session_token=") && !p.endsWith("="))
            .join("; "),
        },
      }),
    )
    expect((await session.json())?.user?.email).toBe(githubEmail)
  })

  it.each([
    [
      "without the state cookie of the browser that started it",
      async () => ({ ...(await startSignIn()), cookie: "" }),
    ],
    [
      "with a state that this deployment did not issue (another preview's)",
      async () => {
        const started = await startSignIn()
        started.url.searchParams.set("state", `other${suffix}`)
        return started
      },
    ],
  ])(
    "refuses a callback %s, and asks GitHub for no token",
    async (_, start) => {
      const { url, cookie } = await start()

      const res = await callback(url.searchParams.get("state") ?? "", cookie)

      expect(res.status).toBe(302)
      expect(
        new URL(res.headers.get("location") ?? "").searchParams.get("error"),
      ).toBe("state_mismatch")
      expect(tokenRequests).toEqual([])
    },
  )
})
