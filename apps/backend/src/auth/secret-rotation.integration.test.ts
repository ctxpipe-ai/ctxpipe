import { randomBytes } from "node:crypto"

import { inArray } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { jwkss, users } from "../db/schema/auth.js"
import { getAuth, resetBetterAuthForTests } from "./config.js"

// After an AUTH_SECRET rotation, the database keeps JWKS keys that the old
// secret encrypted, and browsers keep cookies that the old secret signed.
// Neither may make an auth request fail.

const base = "http://localhost:3000"
const authPath = `${base}/.auth/api/v1/auth`
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const emails: string[] = []
let keysBefore: string[] = []
// Keys that signed a JWT in this file and did not exist when it started.
const ownKeys = new Set<string>()
let oldSecret = ""
const newSecret = randomBytes(32).toString("hex")

const githubEmail = `rotation-github-${suffix}@example.com`
emails.push(githubEmail)
const github = setupServer(
  http.post("https://github.com/login/oauth/access_token", () =>
    HttpResponse.json({
      access_token: "gho_test",
      token_type: "bearer",
      scope: "read:user,user:email",
    }),
  ),
  http.get("https://api.github.com/user", () =>
    HttpResponse.json({
      id: Number.parseInt(suffix.slice(-6), 36),
      login: `rotation-${suffix}`,
      name: "Rotation test",
      email: githubEmail,
      avatar_url: null,
    }),
  ),
  http.get("https://api.github.com/user/emails", () =>
    HttpResponse.json([
      { email: githubEmail, primary: true, verified: true, visibility: null },
    ]),
  ),
)

function cookiePairs(response: Response): string[] {
  return response.headers.getSetCookie().map((part) => part.split(";")[0] ?? "")
}

async function getSession(cookie: string) {
  const response = await getAuth().handler(
    new Request(`${authPath}/get-session`, { headers: { cookie } }),
  )
  const kid = response.headers.has("set-auth-jwt")
    ? jwtKeyId(response)
    : undefined
  if (kid && !keysBefore.includes(kid)) ownKeys.add(kid)
  return response
}

async function signUpAndReadSession(): Promise<string> {
  const email = `rotation-${emails.length}-${suffix}@example.com`
  emails.push(email)
  const signedUp = await getAuth().handler(
    new Request(`${authPath}/sign-up/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Rotation test",
        email,
        password: "password-1234",
      }),
    }),
  )
  expect(signedUp.status).toBe(200)
  const cookie = cookiePairs(signedUp).join("; ")
  // The first JWT signs with (and, if none exists, makes) a JWKS key.
  const session = await getSession(cookie)
  expect(session.status).toBe(200)
  // A cookie that verifies stays.
  expect(
    session.headers
      .getSetCookie()
      .filter((part) => part.includes("session_token=;")),
  ).toHaveLength(0)
  return cookie
}

function jwtKeyId(response: Response): string | undefined {
  const token = response.headers.get("set-auth-jwt") ?? ""
  return (
    JSON.parse(
      Buffer.from(token.split(".")[0] ?? "", "base64url").toString(),
    ) as { kid?: string }
  ).kid
}

async function listedKeyIds(): Promise<string[]> {
  const jwks = await getAuth().handler(new Request(`${authPath}/jwks`))
  const { keys } = (await jwks.json()) as { keys: { kid: string }[] }
  return keys.map((key) => key.kid)
}

/** Use the new secret, as a restarted server does after a rotation. */
function rotateSecret() {
  vi.stubEnv("AUTH_SECRET", newSecret)
  resetBetterAuthForTests()
}

describe("AUTH_SECRET rotation (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is unset: this test needs Postgres")
    }
    initDb(process.env.DATABASE_URL as string)
    github.listen({ onUnhandledRequest: "bypass" })
    keysBefore = (await getSystemDb().select({ id: jwkss.id }).from(jwkss)).map(
      (key) => key.id,
    )
  })

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("SMTP_CONNECTION_URL", "")
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("GITHUB_CLIENT_ID", "rotation-client")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "rotation-client-secret")
    oldSecret = process.env.AUTH_SECRET ?? ""
    expect(oldSecret.length).toBeGreaterThanOrEqual(32)
    resetBetterAuthForTests()
  })

  afterAll(async () => {
    github.close()
    vi.unstubAllEnvs()
    resetBetterAuthForTests()
    const db = getSystemDb()
    // Other files share this table, so remove only the keys that signed a JWT here.
    if (ownKeys.size > 0) {
      await db.delete(jwkss).where(inArray(jwkss.id, [...ownKeys]))
    }
    await db.delete(users).where(inArray(users.email, emails))
    await closeDb()
  })

  it("answers a cookie that the old secret signed with no session and clears it", async () => {
    const staleCookie = await signUpAndReadSession()
    rotateSecret()

    const response = await getSession(staleCookie)

    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
    const cleared = response.headers
      .getSetCookie()
      .filter((part) => part.includes("session_token=;"))
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatch(/Max-Age=0/i)
  })

  it("signs a new session's JWT after the rotation, although the old secret encrypted the newest JWKS key", async () => {
    const oldCookie = await signUpAndReadSession()
    const oldKid = jwtKeyId(await getSession(oldCookie))
    expect(oldKid).toBeTruthy()
    rotateSecret()

    const freshCookie = await signUpAndReadSession()
    const response = await getSession(freshCookie)

    expect(response.status).toBe(200)
    expect((await response.json())?.user?.email).toMatch(/^rotation-/)
    const kid = jwtKeyId(response)
    expect(kid).not.toBe(oldKid)
    // JWKS lists only keys that the current secret can use, so a JWT that
    // an old key signed does not verify.
    const listed = await listedKeyIds()
    expect(listed).toContain(kid)
    expect(listed).not.toContain(oldKid)
  })

  it("signs in with GitHub while the browser still holds a cookie that the old secret signed", async () => {
    const staleCookie = await signUpAndReadSession()
    rotateSecret()

    const started = await getAuth().handler(
      new Request(`${authPath}/sign-in/social`, {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          cookie: staleCookie,
        },
        body: JSON.stringify({ provider: "github", callbackURL: `${base}/` }),
      }),
    )
    expect(started.status).toBe(200)
    const { url } = (await started.json()) as { url: string }
    const state = new URL(url).searchParams.get("state")
    expect(state).toBeTruthy()
    const browserCookie = [staleCookie, ...cookiePairs(started)].join("; ")

    const callback = await getAuth().handler(
      new Request(
        `${authPath}/callback/github?code=test-code&state=${encodeURIComponent(state as string)}`,
        { headers: { cookie: browserCookie } },
      ),
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe(`${base}/`)
    const sessionCookie = cookiePairs(callback)
      .filter((pair) => pair.includes("session_token=") && !pair.endsWith("="))
      .join("; ")
    expect(sessionCookie).toContain("session_token=")

    const session = await getSession(sessionCookie)
    expect(session.status).toBe(200)
    expect((await session.json())?.user?.email).toBe(githubEmail)
  })
})
