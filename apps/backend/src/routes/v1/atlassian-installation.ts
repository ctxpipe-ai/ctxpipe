import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  getAtlassianUserAccessToken,
  getPendingForgeInstallationForUserInOtherOrg,
  type ForgeInstallation,
  upsertPendingForgeInstallation,
} from "../../models/atlassian-connector.js"

const ErrorResponseSchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
    why: z.string().optional(),
    code: z.string().optional(),
  })
  .openapi("AtlassianInstallationErrorResponse")

const AtlassianInstallationSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    cloudId: z.string().nullable(),
    status: z.string(),
    installedByUserId: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("AtlassianInstallation")

const registerAtlassianInstallationRoute = createRoute({
  method: "post",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AtlassianInstallationSchema,
        },
      },
      description: "Atlassian install intent registered for this org",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Atlassian account is not linked or user already has pending install intent in another org",
    },
  },
})

export const atlassianInstallationRoutes = new OpenAPIHono<AppEnv>().openapi(
  registerAtlassianInstallationRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)

    const user = c.get("user") as { id: string }
    const accessToken = await getAtlassianUserAccessToken(user.id)
    if (!accessToken) {
      return c.json(
        {
          error: "Atlassian account not linked",
          code: "atlassian_not_linked",
        },
        409,
      )
    }

    const pendingInOtherOrg = await getPendingForgeInstallationForUserInOtherOrg({
      userId: user.id,
      orgId,
    })
    if (pendingInOtherOrg) {
      return c.json(
        {
          error:
            "A pending Atlassian installation already exists for this user in another organization",
          code: "atlassian_pending_installation_exists",
        },
        409,
      )
    }

    let row: ForgeInstallation
    try {
      row = await upsertPendingForgeInstallation({
        orgId,
        installedByUserId: user.id,
      })
    } catch (error) {
      const dbError = error as { code?: string } | undefined
      if (dbError?.code === "23505") {
        return c.json(
          {
            error:
              "A pending Atlassian installation already exists for this user in another organization",
            code: "atlassian_pending_installation_exists",
          },
          409,
        )
      }
      throw error
    }

    return c.json(
      {
        id: row.id,
        orgId: row.orgId,
        cloudId: row.cloudId ?? null,
        status: row.status,
        installedByUserId: row.installedByUserId ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      200,
    )
  },
)
