import { randomBytes } from "node:crypto"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import type { Env } from "../../config/env.js"
import { formatUnknownError } from "../../db/transientDbRetry.js"
import {
  deletePlainConnection,
  getPlainConnection,
  type PlainConnection,
  savePlainConnection,
  savePlainWebhookTarget,
} from "../../models/plain-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  createPlainWebhookTarget,
  deletePlainWebhookTarget,
  listPlainHelpCenters,
  listPlainLabelTypes,
  PlainUnauthorizedError,
  verifyPlainApiKey,
} from "../../services/plain/client.js"

const ErrorResponseSchema = z.object({ error: z.string() })
const ConnectionIdQuerySchema = z.object({ connectionId: z.string().min(1) })
const error = (description: string) => ({
  content: { "application/json": { schema: ErrorResponseSchema } },
  description,
})
const UNKNOWN_CONNECTION = "Unknown Plain connection"
const RECONNECT_MESSAGE =
  "Plain does not accept the API key of this connection. Reconnect Plain."
const namedItems = z.array(z.object({ id: z.string(), name: z.string() }))

const connectRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            apiKey: z.string().trim().min(1),
            /** Set to replace the key of this connection (a reconnect). */
            connectionId: z.string().min(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            connectionId: z.string(),
            /** False when Plain refused the webhook target: no live updates. */
            webhookConfigured: z.boolean(),
          }),
        },
      },
      description: "The connection is created, or its key is replaced",
    },
    400: error("Plain refused the key, or the key lacks a permission"),
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
    409: error("The connection is for another Plain workspace"),
  },
})

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["installed", "revoked"]),
            workspaceName: z.string(),
            webhookConfigured: z.boolean(),
          }),
        },
      },
      description: "The Plain connection, without secrets",
    },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const catalogRoute = createRoute({
  method: "get",
  path: "/catalog",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ helpCenters: namedItems, labels: namedItems }),
        },
      },
      description: "The Help Centers and labels, for the scope picker",
    },
    400: error(RECONNECT_MESSAGE),
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const deleteRoute = createRoute({
  method: "delete",
  path: "/",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    204: { description: "The connection is removed" },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

/**
 * Create the webhook target of a connection that has none. Plain sends only
 * to a public HTTPS URL, so a refusal leaves the connection without live
 * updates: the daily sync and "Sync now" still work. Gives true when the
 * connection has a target.
 */
async function ensureWebhookTarget(input: {
  orgId: string
  env: Env
  connection: PlainConnection
}): Promise<boolean> {
  const { orgId, env, connection } = input
  if (connection.webhookTargetId) return true
  const token = randomBytes(32).toString("base64url")
  try {
    const webhookTargetId = await createPlainWebhookTarget({
      apiKey: connection.apiKey,
      url: `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/webhook/plain/${connection.id}`,
      token,
    })
    try {
      await savePlainWebhookTarget({
        orgId,
        connectionId: connection.id,
        env,
        webhookTargetId,
        webhookToken: token,
      })
    } catch (saveError) {
      await deletePlainWebhookTarget({
        apiKey: connection.apiKey,
        webhookTargetId,
      })
      throw saveError
    }
    return true
  } catch (caught) {
    getLogger().warn("plain_webhook_create_failed", {
      connectionId: connection.id,
      error: formatUnknownError(caught),
    })
    return false
  }
}

/**
 * Org-admin routes of the Plain connector (ADR-055). The connection holds
 * a machine-user API key; each Workspace selects its Help Centers and
 * labels in its sources.
 */
export const plainConnectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(connectRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const access = await verifyPlainApiKey(body.apiKey)
    if (!access.ok) return c.json({ error: access.error }, 400)
    const saved = await savePlainConnection({
      orgId,
      env: c.var.env,
      connectionId: body.connectionId,
      workspace: access.workspace,
      apiKey: body.apiKey,
    })
    if (!saved.ok)
      return saved.status === 404
        ? c.json({ error: UNKNOWN_CONNECTION }, 404)
        : c.json(
            {
              error:
                "This connection is for another Plain workspace. Add a new connection for it.",
            },
            409,
          )
    const webhookConfigured = await ensureWebhookTarget({
      orgId,
      env: c.var.env,
      connection: saved.connection,
    })
    return c.json({ connectionId: saved.connection.id, webhookConfigured }, 200)
  })
  .openapi(statusRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getPlainConnection(orgId, connectionId, c.var.env)
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    return c.json(
      {
        status: connection.status,
        workspaceName: connection.workspaceName,
        webhookConfigured: connection.webhookTargetId !== null,
      },
      200,
    )
  })
  .openapi(catalogRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getPlainConnection(orgId, connectionId, c.var.env)
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    try {
      const [helpCenters, labels] = await Promise.all([
        listPlainHelpCenters(connection.apiKey),
        listPlainLabelTypes(connection.apiKey),
      ])
      return c.json({ helpCenters, labels }, 200)
    } catch (caught) {
      if (caught instanceof PlainUnauthorizedError)
        return c.json({ error: RECONNECT_MESSAGE }, 400)
      throw caught
    }
  })
  .openapi(deleteRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getPlainConnection(orgId, connectionId, c.var.env)
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    // Remove the target first: a refused key leaves it for a Plain admin.
    if (connection.webhookTargetId)
      try {
        await deletePlainWebhookTarget({
          apiKey: connection.apiKey,
          webhookTargetId: connection.webhookTargetId,
        })
      } catch (caught) {
        getLogger().warn("plain_webhook_delete_failed", {
          connectionId,
          error: formatUnknownError(caught),
        })
      }
    return (await deletePlainConnection(orgId, connectionId))
      ? c.body(null, 204)
      : c.json({ error: UNKNOWN_CONNECTION }, 404)
  })
