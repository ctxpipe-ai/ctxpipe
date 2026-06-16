import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../app/env.js"
import { getAuth } from "../../auth/config.js"
import {
  type DashboardRange,
  getDashboardActivity,
  getDashboardSummary,
} from "../../domain/dashboard.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse")

const DashboardRangeSchema = z.enum(["7d", "30d"]).default("30d")

const DashboardQuerySchema = z
  .object({
    range: DashboardRangeSchema.optional(),
  })
  .openapi("DashboardQuery")

const ActivityCountsSchema = z.object({
  total: z.number().int(),
  ui: z.number().int(),
  mcp: z.number().int(),
  graph: z.number().int(),
  repository: z.number().int(),
  other: z.number().int(),
})

const DashboardActivitySchema = z
  .object({
    range: DashboardRangeSchema,
    buckets: z.array(
      z.object({
        date: z.string(),
        you: ActivityCountsSchema,
        organisation: ActivityCountsSchema,
      }),
    ),
    members: z
      .array(
        ActivityCountsSchema.extend({
          userId: z.string(),
          name: z.string().nullable(),
          email: z.string().nullable(),
          lastActiveAt: z.string().nullable(),
        }),
      )
      .nullable(),
  })
  .openapi("DashboardActivity")

const DashboardActionSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  href: z.string(),
})

const DashboardStatusSchema = z.enum(["ok", "warning", "error", "unknown"])

const DashboardSummarySchema = z
  .object({
    health: z.object({
      overall: DashboardStatusSchema,
      repositories: z.object({
        status: DashboardStatusSchema,
        total: z.number().int(),
        indexed: z.number().int(),
        indexing: z.number().int(),
        notReady: z.number().int(),
      }),
      graph: z.object({
        status: DashboardStatusSchema,
        totalNodes: z.number().int().nullable(),
        totalEdges: z.number().int().nullable(),
        entityTypes: z.number().int().nullable(),
        relationshipTypes: z.number().int().nullable(),
        isolatedNodes: z.number().int().nullable(),
        averageDegree: z.number().nullable(),
        lastObservedAt: z.string().nullable(),
      }),
      connectors: z.object({
        status: DashboardStatusSchema,
        github: z.object({
          total: z.number().int(),
          installed: z.number().int(),
          needsSetup: z.number().int(),
        }),
        forge: z.object({
          total: z.number().int(),
          installed: z.number().int(),
          running: z.number().int(),
          failed: z.number().int(),
        }),
      }),
      confluence: z.object({
        status: DashboardStatusSchema,
        syncTargets: z.number().int(),
        enabledTargets: z.number().int(),
        spaces: z.number().int(),
        lastSyncedAt: z.string().nullable(),
      }),
      evidence: z.object({
        status: DashboardStatusSchema,
        activeClaims: z.number().int(),
        lowConfidenceClaims: z.number().int(),
        contextConfidence: z.number().nullable(),
        confidenceSeries: z.array(
          z.object({
            date: z.string(),
            value: z.number().nullable(),
          }),
        ),
        freshnessSeries: z.array(
          z.object({
            date: z.string(),
            value: z.number().nullable(),
          }),
        ),
        instructionUnits: z.number().int(),
        lastObservedAt: z.string().nullable(),
        freshness: z.object({
          lt24h: z.number().int(),
          lt7d: z.number().int(),
          lt30d: z.number().int(),
          gt30d: z.number().int(),
        }),
      }),
    }),
    actions: z.array(DashboardActionSchema),
    activity: DashboardActivitySchema,
  })
  .openapi("DashboardSummary")

const dashboardSummaryRoute = createRoute({
  method: "get",
  path: "/summary",
  request: { query: DashboardQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: DashboardSummarySchema } },
      description: "Context readiness, action queue, and activity summary",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
  },
})

const dashboardActivityRoute = createRoute({
  method: "get",
  path: "/activity",
  request: { query: DashboardQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: DashboardActivitySchema } },
      description: "Org and current-user context activity buckets",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
  },
})

async function getMemberRoleForRequest(
  c: Context<AppEnv>,
): Promise<string | null> {
  const orgId = c.get("orgId")
  if (!orgId) return null
  try {
    const result = await getAuth().api.getActiveMemberRole({
      headers: c.req.raw.headers,
      query: { organizationId: orgId },
    })
    return typeof result.role === "string" && result.role.length > 0
      ? result.role
      : null
  } catch {
    return null
  }
}

export const dashboardRoutes = new OpenAPIHono<AppEnv>()
  .openapi(dashboardSummaryRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const orgId = c.get("orgId")
    const orgSlug = c.req.param("orgSlug")
    if (!orgId || !orgSlug) return c.json({ error: "Unauthorized" }, 401)
    const memberRole = await getMemberRoleForRequest(c)
    if (!memberRole) return c.json({ error: "Forbidden" }, 403)
    const query = DashboardQuerySchema.parse({
      range: c.req.query("range"),
    })
    const summary = await getDashboardSummary({
      orgId,
      orgSlug,
      userId: user.id,
      range: (query.range ?? "30d") as DashboardRange,
      includeMembers: memberRole === "admin" || memberRole === "owner",
    })
    return c.json(summary, 200)
  })
  .openapi(dashboardActivityRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const memberRole = await getMemberRoleForRequest(c)
    if (!memberRole) return c.json({ error: "Forbidden" }, 403)
    const query = DashboardQuerySchema.parse({
      range: c.req.query("range"),
    })
    const activity = await getDashboardActivity({
      orgId,
      userId: user.id,
      range: (query.range ?? "30d") as DashboardRange,
      includeMembers: memberRole === "admin" || memberRole === "owner",
    })
    return c.json(activity, 200)
  })
