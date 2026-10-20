import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  deleteBuildkiteConnection,
  getBuildkiteConnection,
  saveBuildkiteConnection,
  saveBuildkiteWebhookToken,
} from "../../models/buildkite-connector.js"
import {
  BuildkiteUnauthorizedError,
  listBuildkitePipelines,
  verifyBuildkiteAccess,
} from "../../services/buildkite/client.js"

const ErrorResponseSchema = z.object({ error: z.string() })
const ConnectionIdQuerySchema = z.object({ connectionId: z.string().min(1) })
const error = (description: string) => ({
  content: { "application/json": { schema: ErrorResponseSchema } },
  description,
})
const UNKNOWN_CONNECTION = "Unknown Buildkite connection"
const RECONNECT_MESSAGE =
  "Buildkite does not accept the API access token of this connection. Reconnect Buildkite."

const connectRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            organizationSlug: z
              .string()
              .trim()
              .regex(
                /^[a-z0-9][a-z0-9-]{0,99}$/,
                "Use the Buildkite organization slug, for example acme-inc",
              ),
            apiToken: z.string().trim().min(1).max(500),
            /** Set to replace the token of this connection (a reconnect). */
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
          schema: z.object({ connectionId: z.string() }),
        },
      },
      description: "The connection is created, or its token is replaced",
    },
    400: error("Buildkite refused the token or the organization"),
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
    409: error("The connection is for another Buildkite organization"),
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
            organizationSlug: z.string(),
            /** Add a webhook with this URL in Buildkite. */
            webhookUrl: z.string(),
            webhookConfigured: z.boolean(),
          }),
        },
      },
      description: "The Buildkite connection, without secrets",
    },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const webhookTokenRoute = createRoute({
  method: "put",
  path: "/webhook-token",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            connectionId: z.string().min(1),
            webhookToken: z.string().trim().min(1).max(500),
          }),
        },
      },
    },
  },
  responses: {
    204: { description: "The webhook token is saved" },
    401: error("Unauthorized"),
    404: error(UNKNOWN_CONNECTION),
  },
})

const pipelinesRoute = createRoute({
  method: "get",
  path: "/pipelines",
  request: { query: ConnectionIdQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(z.object({ slug: z.string(), name: z.string() })),
            /** True when the organization has more pipelines than ctx| reads. */
            truncated: z.boolean(),
          }),
        },
      },
      description: "The pipelines of the organization, for the scope picker",
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
 * Org-admin routes of the Buildkite connector (ADR-054). The connection
 * holds auth only; each Workspace selects its pipelines in its sources.
 */
export const buildkiteConnectorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(
    connectRoute,
    async (c) => {
      const orgId = c.get("orgId")
      if (!orgId) return c.json({ error: "Unauthorized" }, 401)
      const body = c.req.valid("json")
      const access = await verifyBuildkiteAccess({
        apiToken: body.apiToken,
        organizationSlug: body.organizationSlug,
      })
      if (!access.ok) return c.json({ error: access.error }, 400)
      const saved = await saveBuildkiteConnection({
        orgId,
        env: c.var.env,
        connectionId: body.connectionId,
        organizationSlug: body.organizationSlug,
        apiToken: body.apiToken,
      })
      if (saved.ok) return c.json({ connectionId: saved.connectionId }, 200)
      return saved.status === 404
        ? c.json({ error: UNKNOWN_CONNECTION }, 404)
        : c.json(
            {
              error:
                "This connection is for another Buildkite organization. Add a new connection for it.",
            },
            409,
          )
    },
    // A readable reason for the setup form, for example a bad slug.
    (result, c) => {
      if (!result.success)
        return c.json(
          { error: result.error.issues[0]?.message ?? "Check the input" },
          400,
        )
      return undefined
    },
  )
  .openapi(statusRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getBuildkiteConnection(
      orgId,
      connectionId,
      c.var.env,
    )
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    return c.json(
      {
        status: connection.status,
        organizationSlug: connection.organizationSlug,
        webhookUrl: `${c.var.env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/webhook/buildkite/${connection.id}`,
        webhookConfigured: connection.hasWebhookToken,
      },
      200,
    )
  })
  .openapi(webhookTokenRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const body = c.req.valid("json")
    const saved = await saveBuildkiteWebhookToken({
      orgId,
      connectionId: body.connectionId,
      env: c.var.env,
      webhookToken: body.webhookToken,
    })
    return saved
      ? c.body(null, 204)
      : c.json({ error: UNKNOWN_CONNECTION }, 404)
  })
  .openapi(pipelinesRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    const connection = await getBuildkiteConnection(
      orgId,
      connectionId,
      c.var.env,
    )
    if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404)
    try {
      const listed = await listBuildkitePipelines({
        apiToken: connection.apiToken,
        organizationSlug: connection.organizationSlug,
      })
      return c.json(
        { items: listed.pipelines, truncated: listed.truncated },
        200,
      )
    } catch (caught) {
      if (caught instanceof BuildkiteUnauthorizedError)
        return c.json({ error: RECONNECT_MESSAGE }, 400)
      throw caught
    }
  })
  .openapi(deleteRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const { connectionId } = c.req.valid("query")
    return (await deleteBuildkiteConnection(orgId, connectionId))
      ? c.body(null, 204)
      : c.json({ error: UNKNOWN_CONNECTION }, 404)
  })
