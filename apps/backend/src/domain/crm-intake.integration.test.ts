import { eq, like } from "drizzle-orm"
import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { useMswServer } from "../../test/msw.js"
import { getAuth, resetBetterAuthForTests } from "../auth/config.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { members, organizations, users } from "../db/schema/auth.js"
import { crmIntakeOutbox } from "../db/schema/crm_intake_outbox.js"
import {
  recordSignupForCrm,
  REFUSED_ALERT_MESSAGE,
  STALE_ALERT_MESSAGE,
  sendDueSignups,
} from "./crm-intake.js"

const base = "http://localhost:3000"
const intakeUrl = "https://crm.example.test/intake/v1/contacts"
const target = {
  url: intakeUrl,
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
}
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const emailDomain = `crm-${suffix}.example.com`
const personName = `Ada Testperson ${suffix}`

type Posted = { headers: Headers; body: Record<string, unknown> }
const posted: Posted[] = []
let reply: () => Response = () => new Response(null, { status: 202 })
const server = useMswServer()

const events: Record<string, unknown>[] = []

/** No log event holds the email or the name of a test user. */
function expectNoUserData() {
  const logged = JSON.stringify(events)
  expect(logged).not.toContain(emailDomain)
  expect(logged).not.toContain(personName)
}

let userCount = 0
/** A user row made directly, with a made-up id and email. */
async function newUser(): Promise<{ id: string; email: string }> {
  userCount++
  const user = {
    id: `user_crm_${suffix}_${userCount}`,
    email: `person-${userCount}@${emailDomain}`,
  }
  await getSystemDb()
    .insert(users)
    .values({ ...user, name: personName, emailVerified: true })
  return user
}

/** A due outbox row for a new user, as the hook writes it. */
async function dueRow(
  fields: Partial<typeof crmIntakeOutbox.$inferInsert> = {},
) {
  const user = await newUser()
  const id = `crmo_${suffix}_${userCount}`
  await getSystemDb()
    .insert(crmIntakeOutbox)
    .values({
      id,
      userId: user.id,
      payload: {
        email: user.email,
        name: personName,
        occurredAt: "2026-11-25T10:00:00.000Z",
        externalId: user.id,
      },
      nextAttemptAt: new Date(Date.now() - 1000),
      ...fields,
    })
  return { id, user }
}

async function row(id: string) {
  const [found] = await getSystemDb()
    .select()
    .from(crmIntakeOutbox)
    .where(eq(crmIntakeOutbox.id, id))
  return found
}

describe("CRM intake outbox (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required: run pnpm db:migrate first")
    initDb(process.env.DATABASE_URL)
    // The events go to the global drain, as in production.
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
      drain: (ctx) => {
        events.push(ctx.event as Record<string, unknown>)
      },
    })
  })

  beforeEach(() => {
    posted.length = 0
    reply = () => new Response(null, { status: 202 })
    server.use(
      http.post(intakeUrl, async ({ request }) => {
        posted.push({
          headers: request.headers,
          body: (await request.json()) as Record<string, unknown>,
        })
        return reply()
      }),
    )
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    resetBetterAuthForTests()
    initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
    try {
      await getSystemDb()
        .delete(organizations)
        .where(like(organizations.slug, `crm-${suffix}%`))
      // The outbox rows go with their users.
      await getSystemDb()
        .delete(users)
        .where(like(users.email, `%@${emailDomain}`))
    } finally {
      await closeDb()
    }
  })

  describe("the sign-up hook", () => {
    function signUpIn(deployment: string) {
      vi.stubEnv("DEPLOYMENT_ENVIRONMENT", deployment)
      vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
      vi.stubEnv("CRM_INTAKE_URL", intakeUrl)
      vi.stubEnv("AUTH_BASE_URL", base)
      vi.stubEnv("AUTH_SECRET", "crm-intake-test-secret-of-32-chars-at-least")
      // No email transport: the sign-up needs no verification.
      vi.stubEnv("EMAIL_FROM_ADDRESS", "")
      resetBetterAuthForTests()
      userCount++
      return getAuth().handler(
        new Request(`${base}/.auth/api/v1/auth/sign-up/email`, {
          method: "POST",
          headers: { origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            name: personName,
            email: `signup-${userCount}@${emailDomain}`,
            password: "crm-intake-password-1",
          }),
        }),
      )
    }

    it("writes an outbox row for each new user in production and sends nothing", async () => {
      const response = await signUpIn("production")
      expect(response.status).toBe(200)
      const { user } = (await response.json()) as {
        user: { id: string; email: string; createdAt: string }
      }

      const [outbox] = await getSystemDb()
        .select()
        .from(crmIntakeOutbox)
        .where(eq(crmIntakeOutbox.userId, user.id))
      expect(outbox).toMatchObject({
        attempts: 0,
        sentAt: null,
        payload: {
          email: user.email,
          name: personName,
          occurredAt: new Date(user.createdAt).toISOString(),
          externalId: user.id,
        },
      })
      // The first send waits for the onboarding.
      expect(outbox?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
      expect(posted).toEqual([])
    })

    it("writes no row on a preview", async () => {
      const response = await signUpIn("pr-42")
      expect(response.status).toBe(200)
      const { user } = (await response.json()) as { user: { id: string } }
      expect(
        await getSystemDb()
          .select()
          .from(crmIntakeOutbox)
          .where(eq(crmIntakeOutbox.userId, user.id)),
      ).toEqual([])
    })

    it("does not throw when the insert fails, and logs no user data", async () => {
      events.length = 0
      // No user has this id, so the foreign key refuses the row.
      await expect(
        recordSignupForCrm({
          id: `user_crm_${suffix}_missing`,
          email: `missing@${emailDomain}`,
          name: personName,
          createdAt: new Date(),
        }),
      ).resolves.toBeUndefined()

      const failure = events.find((e) => e.step === "crm-intake.record")
      expect(failure).toMatchObject({ level: "error", sqlState: "23503" })
      expectNoUserData()
    })
  })

  describe("the sender", () => {
    it("keeps the body of the first try, with its organization, for each later try", async () => {
      reply = () => new Response(null, { status: 503 })
      const { id, user } = await dueRow()
      const orgId = `org_crm_${suffix}_rename`
      await getSystemDb()
        .insert(organizations)
        .values({
          id: orgId,
          name: "First Name Ltd",
          slug: `crm-${suffix}-rename`,
          createdAt: new Date(),
        })
      await getSystemDb()
        .insert(members)
        .values({
          id: `mbr_crm_${suffix}_rename`,
          organizationId: orgId,
          userId: user.id,
          createdAt: new Date(),
        })
      const now = new Date()
      await sendDueSignups(target, now)
      await getSystemDb()
        .update(organizations)
        .set({ name: "Renamed Ltd" })
        .where(eq(organizations.id, orgId))
      await sendDueSignups(target, new Date(now.getTime() + 3_600_000))

      const bodies = posted
        .filter((p) => p.body.externalId === user.id)
        .map((p) => p.body)
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toEqual(bodies[0])
      expect(bodies[0]?.company).toBe("First Name Ltd")
      expect((await row(id))?.attempts).toBe(2)
    })

    it("cuts a long name to 200 characters, and refuses a body over 16 KiB without sending it", async () => {
      events.length = 0
      // 4-byte characters: the cut counts characters, not bytes.
      const longName = "\u{1F600}".repeat(300)
      const signup = await newUser()
      await recordSignupForCrm({
        ...signup,
        name: longName,
        createdAt: new Date(),
      })
      const [recorded] = await getSystemDb()
        .select()
        .from(crmIntakeOutbox)
        .where(eq(crmIntakeOutbox.userId, signup.id))
      expect(recorded?.payload?.name).toBe("\u{1F600}".repeat(200))

      const { id, user } = await dueRow()
      await getSystemDb()
        .update(crmIntakeOutbox)
        .set({
          payload: {
            email: `${"x".repeat(16 * 1024)}@${emailDomain}`,
            occurredAt: "2026-11-25T10:00:00.000Z",
            externalId: user.id,
          },
        })
        .where(eq(crmIntakeOutbox.id, id))
      const now = new Date()
      await sendDueSignups(target, now)
      expect(await row(id)).toMatchObject({
        failedAt: now,
        lastStatus: "too_large",
      })
      expect(posted.find((p) => p.body.externalId === user.id)).toBeUndefined()
      expectNoUserData()
    })

    it("sends a due row with the Access token and the user's organization, then clears its payload", async () => {
      const { id, user } = await dueRow()
      const orgId = `org_crm_${suffix}`
      await getSystemDb()
        .insert(organizations)
        .values({
          id: orgId,
          name: "Analytical Engines",
          slug: `crm-${suffix}`,
          createdAt: new Date(),
        })
      await getSystemDb()
        .insert(members)
        .values({
          id: `mbr_crm_${suffix}`,
          organizationId: orgId,
          userId: user.id,
          createdAt: new Date(),
        })

      const now = new Date()
      expect(await sendDueSignups(target, now)).toMatchObject({ sent: 1 })

      const request = posted.find((p) => p.body.externalId === user.id)
      expect(request?.headers.get("cf-access-client-id")).toBe("test-client-id")
      expect(request?.headers.get("cf-access-client-secret")).toBe(
        "test-client-secret",
      )
      expect(request?.body).toEqual({
        source: "app-signup",
        email: user.email,
        name: personName,
        occurredAt: "2026-11-25T10:00:00.000Z",
        externalId: user.id,
        company: "Analytical Engines",
      })
      expect(await row(id)).toMatchObject({
        sentAt: now,
        lastStatus: "202",
        payload: null,
        attempts: 1,
      })
      expectNoUserData()

      // A sent row is not sent again.
      posted.length = 0
      await sendDueSignups(target, new Date(now.getTime() + 86_400_000))
      expect(posted.find((p) => p.body.externalId === user.id)).toBeUndefined()
    })

    it.each([
      ["a 503", () => new Response(null, { status: 503 }), "503"],
      ["a 429", () => new Response(null, { status: 429 }), "429"],
      ["a network error", () => HttpResponse.error(), "network"],
    ])(
      "tries again later with backoff after %s",
      async (_, response, status) => {
        reply = response
        const { id } = await dueRow({ attempts: 2 })
        const now = new Date()
        await sendDueSignups(target, now)
        // The third try failed: the next one waits 4 minutes.
        expect(await row(id)).toMatchObject({
          attempts: 3,
          lastStatus: status,
          sentAt: null,
          failedAt: null,
          nextAttemptAt: new Date(now.getTime() + 240_000),
        })
      },
    )

    it("stops a refused row and alerts", async () => {
      events.length = 0
      reply = () =>
        HttpResponse.json({ error: "invalid body" }, { status: 400 })
      const { id, user } = await dueRow()
      const now = new Date()
      await sendDueSignups(target, now)
      expect(await row(id)).toMatchObject({ failedAt: now, lastStatus: "400" })
      expect(events).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: REFUSED_ALERT_MESSAGE,
          outboxId: id,
          status: "400",
        }),
      )
      expectNoUserData()

      // A refused row is not sent again.
      posted.length = 0
      await sendDueSignups(target, new Date(now.getTime() + 86_400_000))
      expect(posted.find((p) => p.body.externalId === user.id)).toBeUndefined()
    })

    it("alerts when a row is older than 24 hours and not sent", async () => {
      events.length = 0
      const now = new Date()
      await dueRow({
        createdAt: new Date(now.getTime() - 25 * 3_600_000),
        nextAttemptAt: new Date(now.getTime() + 3_600_000),
      })
      await sendDueSignups(target, now)
      expect(events).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: STALE_ALERT_MESSAGE,
        }),
      )
      expectNoUserData()
    })
  })
})
