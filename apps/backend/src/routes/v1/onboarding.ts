import { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { getAuth } from "../../auth/config.js"
import { getSystemDb } from "../../db/client.js"
import { organizations, users } from "../../db/schema/auth.js"
import { onboardingOrgCreationRequests } from "../../db/schema/onboarding_org_creation_requests.js"
import { orgOnboarding } from "../../db/schema/org_onboarding.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("OnboardingErrorResponse")

const createOnboardingOrganizationHeadersSchema = z.object({
  "idempotency-key": z.string().trim().min(1).max(128),
})

const createOnboardingOrganizationBodySchema = z.object({
  name: z.string().trim().min(1).max(128),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
})

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

const createOnboardingOrganizationRoute = createRoute({
  method: "post",
  path: "/organizations",
  request: {
    headers: createOnboardingOrganizationHeadersSchema,
    body: {
      content: {
        "application/json": {
          schema: createOnboardingOrganizationBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              organization: z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
              }),
              replayed: z.boolean(),
            })
            .openapi("OnboardingCreateOrganizationResponse"),
        },
      },
      description:
        "Organization created for onboarding, or previous result replayed by idempotency key.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Request already in progress for this idempotency key",
    },
  },
})

async function getOrganizationById(organizationId: string) {
  const db = getSystemDb()
  const [organization] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  return organization ?? null
}

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
.openapi(createOnboardingOrganizationRoute, async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Unauthorized" }, 401)

  const headerValidation = createOnboardingOrganizationHeadersSchema.safeParse({
    "idempotency-key": c.req.header("idempotency-key"),
  })
  if (!headerValidation.success) {
    return c.json({ error: "Missing or invalid Idempotency-Key header." }, 400)
  }

  const parsedBody = await c.req.json().catch(() => null)
  const bodyValidation =
    createOnboardingOrganizationBodySchema.safeParse(parsedBody)
  if (!bodyValidation.success) {
    return c.json({ error: "Invalid onboarding organization payload." }, 400)
  }

  const { "idempotency-key": idempotencyKey } = headerValidation.data
  const { name, slug } = bodyValidation.data
  const db = getSystemDb()

  const [existingRequest] = await db
    .select({
      organizationId: onboardingOrgCreationRequests.organizationId,
    })
    .from(onboardingOrgCreationRequests)
    .where(
      and(
        eq(onboardingOrgCreationRequests.userId, user.id),
        eq(onboardingOrgCreationRequests.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)

  if (existingRequest?.organizationId) {
    const existingOrganization = await getOrganizationById(
      existingRequest.organizationId,
    )
    if (!existingOrganization) {
      return c.json(
        { error: "Previous onboarding organization was not found." },
        409,
      )
    }
    return c.json({ organization: existingOrganization, replayed: true }, 200)
  }

  if (existingRequest && !existingRequest.organizationId) {
    return c.json(
      {
        error:
          "Organization creation is already in progress for this request. Please retry shortly.",
      },
      409,
    )
  }

  const claim = await db
    .insert(onboardingOrgCreationRequests)
    .values({
      userId: user.id,
      idempotencyKey,
      organizationId: null,
    })
    .onConflictDoNothing({
      target: [
        onboardingOrgCreationRequests.userId,
        onboardingOrgCreationRequests.idempotencyKey,
      ],
    })
    .returning({
      userId: onboardingOrgCreationRequests.userId,
    })

  if (claim.length === 0) {
    const [concurrentRequest] = await db
      .select({
        organizationId: onboardingOrgCreationRequests.organizationId,
      })
      .from(onboardingOrgCreationRequests)
      .where(
        and(
          eq(onboardingOrgCreationRequests.userId, user.id),
          eq(onboardingOrgCreationRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)

    if (concurrentRequest?.organizationId) {
      const existingOrganization = await getOrganizationById(
        concurrentRequest.organizationId,
      )
      if (!existingOrganization) {
        return c.json(
          { error: "Previous onboarding organization was not found." },
          409,
        )
      }
      return c.json({ organization: existingOrganization, replayed: true }, 200)
    }

    return c.json(
      {
        error:
          "Organization creation is already in progress for this request. Please retry shortly.",
      },
      409,
    )
  }

  try {
    const created = await getAuth().api.createOrganization({
      headers: c.req.raw.headers,
      body: { name, slug },
    })

    const createdOrganization = {
      id: created.id,
      name: created.name,
      slug: created.slug,
    }

    await db
      .update(onboardingOrgCreationRequests)
      .set({
        organizationId: createdOrganization.id,
      })
      .where(
        and(
          eq(onboardingOrgCreationRequests.userId, user.id),
          eq(onboardingOrgCreationRequests.idempotencyKey, idempotencyKey),
        ),
      )

    return c.json({ organization: createdOrganization, replayed: false }, 200)
  } catch (error) {
    await db
      .delete(onboardingOrgCreationRequests)
      .where(
        and(
          eq(onboardingOrgCreationRequests.userId, user.id),
          eq(onboardingOrgCreationRequests.idempotencyKey, idempotencyKey),
        ),
      )

    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : "Failed to create organization."
    return c.json({ error: message }, 409)
  }
})

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

    const db = getSystemDb()
    const [row] = await db
      .select({ completedAt: orgOnboarding.completedAt })
      .from(orgOnboarding)
      .where(eq(orgOnboarding.organizationId, orgId))

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
    const db = getSystemDb()
    await db
      .insert(orgOnboarding)
      .values({
        organizationId: orgId,
        completedAt: now,
        completedByUserId: user.id,
      })
      .onConflictDoUpdate({
        target: orgOnboarding.organizationId,
        set: { completedAt: now, completedByUserId: user.id },
      })

    return c.json({ completedAt: now.toISOString() }, 200)
  })
