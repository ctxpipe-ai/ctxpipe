import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { users } from "../db/schema/auth.js"
import { type FakeSmtp, startFakeSmtp } from "../test/fake-smtp.js"
import { getAuth, resetBetterAuthForTests } from "./config.js"

const base = "http://localhost:3000"
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const emails: string[] = []
let smtp: FakeSmtp

function newEmail(): string {
  const email = `verify-${emails.length}-${suffix}@example.com`
  emails.push(email)
  return email
}

function mailsTo(email: string) {
  return smtp.mails.filter((mail) => mail.to === email)
}

function post(path: string, body: Record<string, unknown>, cookie?: string) {
  return getAuth().handler(
    new Request(`${base}/.auth/api/v1/auth${path}`, {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

function signUp(email: string, password: string, callbackURL?: string) {
  return post("/sign-up/email", {
    name: "Verification test",
    email,
    password,
    ...(callbackURL ? { callbackURL } : {}),
  })
}

/** Mail is sent through SMTP, so email verification is required. */
function withSmtp() {
  vi.stubEnv("SMTP_CONNECTION_URL", `smtp://127.0.0.1:${smtp.port}`)
  resetBetterAuthForTests()
}

describeWithDatabase("email verification (Postgres)", () => {
  beforeAll(async () => {
    initDb(process.env.DATABASE_URL as string)
    smtp = await startFakeSmtp()
  })

  beforeEach(() => {
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.com")
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    withSmtp()
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    resetBetterAuthForTests()
    if (emails.length > 0) {
      await getSystemDb().delete(users).where(inArray(users.email, emails))
    }
    await closeDb()
    await smtp.close()
  })

  it("signs up without a session and emails a link that verifies and signs in", async () => {
    const email = newEmail()

    const signedUp = await signUp(email, "password-1234", `${base}/onboarding`)

    expect(await signedUp.json()).toMatchObject({ token: null })
    const link = /href="([^"]*\/verify-email\?[^"]+)"/.exec(
      mailsTo(email)[0]?.body ?? "",
    )?.[1]
    expect(link).toMatch(`${base}/.auth/api/v1/auth/verify-email?token=`)
    const verified = await getAuth().handler(new Request(link as string))
    expect(verified.headers.get("location")).toBe(`${base}/onboarding`)
    expect(verified.headers.getSetCookie().join()).toContain("session_token")
  })

  it("refuses an unverified sign-in and emails a fresh link", async () => {
    const email = newEmail()
    await signUp(email, "password-1234")

    const signIn = await post("/sign-in/email", {
      email,
      password: "password-1234",
    })

    expect(signIn.status).toBe(403)
    expect(await signIn.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" })
    expect(mailsTo(email).map((mail) => mail.subject)).toEqual([
      "Verify your email address",
      "Verify your email address",
    ])
  })

  it("answers a sign-up with an unverified account's address with the account-exists email, not a link into that account", async () => {
    const email = newEmail()

    expect((await signUp(email, "first-registrant-password")).status).toBe(200)
    expect((await signUp(email, "address-owner-password")).status).toBe(200)

    expect(mailsTo(email).map((mail) => mail.subject)).toEqual([
      "Verify your email address",
      "You already have a ctxpipe account",
    ])
  })

  it("links the account-exists email's sign-in back to where the sign-up started", async () => {
    const email = newEmail()
    const invitation = `${base}/.auth/accept-invitation?invitationId=inv_test`

    await signUp(email, "first-password", invitation)
    await signUp(email, "second-password", invitation)

    expect(mailsTo(email).at(-1)?.body).toContain(
      `${base}/.auth/sign-in?redirectTo=${encodeURIComponent(invitation)}`,
    )
  })

  it("verifies an unverified account through a password reset and signs out its other sessions", async () => {
    const email = newEmail()
    // An account from before verification was required: unverified, signed in.
    vi.stubEnv("SMTP_CONNECTION_URL", "")
    resetBetterAuthForTests()
    const legacy = await signUp(email, "first-registrant-password")
    const cookie = legacy.headers
      .getSetCookie()
      .map((part) => part.split(";")[0])
      .join("; ")
    withSmtp()

    await post("/request-password-reset", {
      email,
      redirectTo: `${base}/.auth/reset-password`,
    })
    const token = /\/reset-password\/([^?"]+)/.exec(
      mailsTo(email).at(-1)?.body ?? "",
    )?.[1]
    const reset = await post("/reset-password", {
      token,
      newPassword: "address-owner-password",
    })

    expect(reset.status).toBe(200)
    const signIn = await post("/sign-in/email", {
      email,
      password: "address-owner-password",
    })
    expect(signIn.status).toBe(200)
    expect(
      await getAuth().api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull()
  })
})
