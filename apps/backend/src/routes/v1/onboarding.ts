import { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { users } from "../../db/schema/auth.js"
import { orgOnboarding } from "../../db/schema/org_onboarding.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("OnboardingErrorResponse")

// ── User onboarding ────────────────────────────────────────────────

const completeUserOnboardingRoute = createRoute({
  method: "post",
  path: "/user/complete",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({ completedAt: z.string().datetime() })
            .openapi("UserOnboardingCompleteResponse"),
        },
      },
      description: "User onboarding marked complete",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

export const userOnboardingRoutes = new OpenAPIHono<AppEnv>().openapi(
  completeUserOnboardingRoute,
  async (c) => {
    const user = c.get("user")
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const now = new Date()
    const db = getSystemDb()
    await db
      .update(users)
      .set({ onboardingCompletedAt: now })
      .where(eq(users.id, user.id))

    return c.json({ completedAt: now.toISOString() }, 200)
  },
)

// ── Org onboarding ─────────────────────────────────────────────────

const getOrgOnboardingRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              completedAt: z.string().datetime().nullable(),
            })
            .openapi("OrgOnboardingStateResponse"),
        },
      },
      description: "Org onboarding state",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const completeOrgOnboardingRoute = createRoute({
  method: "post",
  path: "/complete",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({ completedAt: z.string().datetime() })
            .openapi("OrgOnboardingCompleteResponse"),
        },
      },
      description: "Org onboarding marked complete",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

export const orgOnboardingRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getOrgOnboardingRoute, async (c) => {
    const user = c.get("user")
    const orgId = c.get("orgId")
    if (!user || !orgId) return c.json({ error: "Unauthorized" }, 401)

    const [row] = await withOrgDbContext(orgId, async (db) =>
      db
        .select({ completedAt: orgOnboarding.completedAt })
        .from(orgOnboarding)
        .where(eq(orgOnboarding.organizationId, orgId)),
    )

    return c.json(
      { completedAt: row?.completedAt?.toISOString() ?? null },
      200,
    )
  })
  .openapi(completeOrgOnboardingRoute, async (c) => {
    const user = c.get("user")
    const orgId = c.get("orgId")
    if (!user || !orgId) return c.json({ error: "Unauthorized" }, 401)

    const now = new Date()
    await withOrgDbContext(orgId, async (db) =>
      db
        .insert(orgOnboarding)
        .values({
          organizationId: orgId,
          completedAt: now,
          completedByUserId: user.id,
        })
        .onConflictDoUpdate({
          target: orgOnboarding.organizationId,
          set: { completedAt: now, completedByUserId: user.id },
        }),
    )

    return c.json({ completedAt: now.toISOString() }, 200)
  })
