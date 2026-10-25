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
    id: z.string(),
    legacy: z.boolean(),
    clientId: z.string(),
    clientName: z.string().nullable(),
    scopes: z.array(z.string()),
    organizations: z.array(
      z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    ),
    connectedAt: z.string().nullable(),
  })
  .openapi("ConnectedApp")

const ConsentParamsSchema = z.object({
  consentId: z
    .string()
    .min(1)
    .openapi({ param: { name: "consentId", in: "path" } }),
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
      description: "The OAuth consents of the signed-in user",
    },
    401: errorResponse("No credential"),
    403: errorResponse("Not a signed-in user session"),
  },
})

const setConnectedAppOrganizationsRoute = createRoute({
  method: "put",
  path: "/{consentId}/organizations",
  request: {
    params: ConsentParamsSchema,
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
    204: { description: "The grant has the new org set" },
    400: errorResponse("An empty set, or an org the user is not a member of"),
    401: errorResponse("No credential"),
    403: errorResponse("Not a signed-in user session"),
    404: errorResponse("No such consent for this user"),
    409: errorResponse("A legacy consent: reconnect to choose more orgs"),
  },
})

const revokeConnectedAppRoute = createRoute({
  method: "delete",
  path: "/{consentId}",
  request: { params: ConsentParamsSchema },
  responses: {
    204: { description: "Revoked" },
    401: errorResponse("No credential"),
    403: errorResponse("Not a signed-in user session"),
    404: errorResponse("No such consent for this user"),
  },
})

/** The user who manages the consents through a browser session. */
function sessionUserId(c: Context<AppEnv>): string | null {
  if (!c.get("session")) return null
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
    const { consentId } = c.req.valid("param")
    const { organizationIds } = c.req.valid("json")
    const result = await setConnectedAppOrganizations({
      userId,
      consentId,
      organizationIds,
    })
    if (result === "not_found") return c.json({ error: NOT_FOUND }, 404)
    if (result === "legacy") {
      return c.json(
        { error: "Reconnect this app to choose more organizations" },
        409,
      )
    }
    if (result === "not_member") {
      return c.json(
        { error: "You can select only organizations that you are a member of" },
        400,
      )
    }
    return c.body(null, 204)
  })
  .openapi(revokeConnectedAppRoute, async (c) => {
    const userId = sessionUserId(c)
    if (!userId) return c.json({ error: NOT_SESSION }, 403)
    const { consentId } = c.req.valid("param")
    const revoked = await revokeConnectedApp({ userId, consentId })
    if (!revoked) return c.json({ error: NOT_FOUND }, 404)
    return c.body(null, 204)
  })
