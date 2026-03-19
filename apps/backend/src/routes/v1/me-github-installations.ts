import { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { getOrganizationSlugForInstallationByUser } from "../../models/github-installation.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("MeGitHubInstallationErrorResponse")

const MeInstallationOrganizationResponseSchema = z
  .object({ orgSlug: z.string() })
  .openapi("MeInstallationOrganizationResponse")

export const getMyInstallationOrganizationRoute = createRoute({
  method: "get",
  path: "/:installationId/organization",
  request: {
    params: z.object({
      installationId: z.coerce.number().int().positive(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: MeInstallationOrganizationResponseSchema,
        },
      },
      description: "Organization slug for this installation and current user",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No matching organization found",
    },
  },
})

export const meGithubInstallationsRoutes = new OpenAPIHono<AppEnv>().openapi(
  getMyInstallationOrganizationRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const user = c.get("user") as { id: string }
    const installationId = Number(c.req.param("installationId"))
    const orgSlug = await getOrganizationSlugForInstallationByUser(
      user.id,
      installationId,
    )
    if (!orgSlug) {
      return c.json({ error: "Not found" }, 404)
    }
    return c.json({ orgSlug }, 200)
  },
)
