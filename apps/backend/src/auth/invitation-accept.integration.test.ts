import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { getSystemDb } from "../db/client.js"
import { users } from "../db/schema/auth.js"
import { getAuth, resetBetterAuthForTests } from "./config.js"

/**
 * The answers the invitation page maps to its messages (CTX-867), on a PR
 * preview: email verification is off there, so Better Auth tells a sign-up
 * that the address already has an account.
 */
const base = "http://localhost:3000"
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const emails: string[] = []
let owner: SeededOrg

function newEmail(name: string): string {
  const email = `invite-${name}-${suffix}@example.com`
  emails.push(email)
  return email
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

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((part) => part.split(";")[0])
    .join("; ")
}

function signUp(email: string) {
  return post("/sign-up/email", {
    name: "Invitee",
    email,
    password: "invitee-password",
  })
}

async function invite(email: string): Promise<string> {
  const invitation = await getAuth().api.createInvitation({
    body: { email, role: "member", organizationId: owner.orgId },
    headers: new Headers({ origin: base, cookie: owner.cookie }),
  })
  return invitation.id
}

function accept(invitationId: string, cookie: string) {
  return post("/organization/accept-invitation", { invitationId }, cookie)
}

describe("invitation accept on a PR preview (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is unset: this test needs Postgres.")
    }
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-1")
    vi.stubEnv("SMTP_CONNECTION_URL", "")
    resetBetterAuthForTests()
    owner = await seedOrg()
  })

  afterAll(async () => {
    if (emails.length > 0) {
      await getSystemDb().delete(users).where(inArray(users.email, emails))
    }
    if (owner) await cleanupSeededOrg(owner)
    vi.unstubAllEnvs()
  })

  it("refuses a sign-up for an existing account with the code the page maps, then accepts after sign-in", async () => {
    const email = newEmail("existing")
    expect((await signUp(email)).status).toBe(200)
    const invitationId = await invite(email)

    const again = await signUp(email)
    expect(again.status).toBe(422)
    expect(await again.json()).toMatchObject({
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
    })

    const signIn = await post("/sign-in/email", {
      email,
      password: "invitee-password",
    })
    expect(signIn.status).toBe(200)
    const accepted = await accept(invitationId, cookieOf(signIn))
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      member: { organizationId: owner.orgId, role: "member" },
    })

    const used = await accept(invitationId, cookieOf(signIn))
    expect(used.status).toBe(400)
    expect(await used.json()).toMatchObject({ code: "INVITATION_NOT_FOUND" })
  })

  it("lets a new user sign up and accept, and refuses another account", async () => {
    const email = newEmail("new")
    const invitationId = await invite(email)
    const other = await signUp(newEmail("other"))

    const wrong = await accept(invitationId, cookieOf(other))
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    })

    const signedUp = await signUp(email)
    expect(signedUp.status).toBe(200)
    const accepted = await accept(invitationId, cookieOf(signedUp))
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      member: { organizationId: owner.orgId },
    })
  })
})
