import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../app/env.js"
import {
  type ConnectedApp,
  listConnectedApps,
  revokeConnectedApp,
  setConnectedAppOrganizations,
} from "../../auth/oauth-grants.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ConnectedAppErrorResponse")

const ConnectedAppSchema = z
  .object({
    grantId: z.string(),
    clientId: z.string(),
    clientName: z.string().nullable(),
    scopes: z.array(z.string()),
    organizations: z.array(
      z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    ),
    connectedAt: z.string().nullable(),
  })
  .openapi("ConnectedApp")

const GrantParamsSchema = z.object({
  grantId: z
    .string()
    .min(1)
    .openapi({ param: { name: "grantId", in: "path" } }),
})

const errorResponse = (description: string) => ({
  content: { "application/json": { schema: ErrorResponseSchema } },
  description,
})

const listConnectedAppsRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({ apps: z.array(ConnectedAppSchema) })
            .openapi("ConnectedAppList"),
        },
      },
      description: "The OAuth grants of the signed-in user",
    },
    403: errorResponse("Not a signed-in user session"),
  },
})

const setConnectedAppOrganizationsRoute = createRoute({
  method: "put",
  path: "/{grantId}/organizations",
  request: {
    params: GrantParamsSchema,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ organizationIds: z.array(z.string().min(1)).min(1) })
            .openapi("ConnectedAppOrganizationsBody"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ConnectedAppSchema } },
      description: "The grant with its new org set",
    },
    400: errorResponse("An empty set, or an org the user is not a member of"),
    403: errorResponse("Not a signed-in user session"),
    404: errorResponse("No such grant for this user"),
  },
})

const revokeConnectedAppRoute = createRoute({
  method: "delete",
  path: "/{grantId}",
  request: { params: GrantParamsSchema },
  responses: {
    204: { description: "Revoked" },
    403: errorResponse("Not a signed-in user session"),
    404: errorResponse("No such grant for this user"),
  },
})

/**
 * The user who edits the grants. Only a signed-in user session can do this:
 * an OAuth token, a personal API key, or an org API key cannot change grants.
 */
function sessionUserId(c: Context<AppEnv>): string | null {
  if (
    c.get("oauthReferenceId") ||
    c.get("oauthClientId") ||
    c.get("personalApiKeyId") ||
    c.get("orgApiKey")
  ) {
    return null
  }
  return c.get("user")?.id ?? null
}

function toJson(app: ConnectedApp) {
  return { ...app, connectedAt: app.connectedAt?.toISOString() ?? null }
}

const NOT_SESSION = "Sign in to manage connected apps"
const NOT_FOUND = "Connected app not found"

/** `/api/v1/me/connected-apps`: the user's OAuth grants (ADR-051). */
export const meConnectedAppsRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listConnectedAppsRoute, async (c) => {
    const userId = sessionUserId(c)
    if (!userId) return c.json({ error: NOT_SESSION }, 403)
    const apps = await listConnectedApps(userId)
    return c.json({ apps: apps.map(toJson) }, 200)
  })
  .openapi(setConnectedAppOrganizationsRoute, async (c) => {
    const userId = sessionUserId(c)
    if (!userId) return c.json({ error: NOT_SESSION }, 403)
    const { grantId } = c.req.valid("param")
    const { organizationIds } = c.req.valid("json")
    const result = await setConnectedAppOrganizations({
      userId,
      grantId,
      organizationIds,
    })
    if (result === "not_found") return c.json({ error: NOT_FOUND }, 404)
    if (result === "empty") {
      return c.json({ error: "Select at least one organization" }, 400)
    }
    if (result === "not_member") {
      return c.json(
        { error: "You can add only organizations that you are a member of" },
        400,
      )
    }
    const [app] = await listConnectedApps(userId, grantId)
    if (!app) return c.json({ error: NOT_FOUND }, 404)
    return c.json(toJson(app), 200)
  })
  .openapi(revokeConnectedAppRoute, async (c) => {
    const userId = sessionUserId(c)
    if (!userId) return c.json({ error: NOT_SESSION }, 403)
    const { grantId } = c.req.valid("param")
    const revoked = await revokeConnectedApp({ userId, grantId })
    if (!revoked) return c.json({ error: NOT_FOUND }, 404)
    return c.body(null, 204)
  })
