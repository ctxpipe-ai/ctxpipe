import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import type { AppEnv } from "../../app/env.js"
import { CONNECTION_STATUSES } from "../../models/connection-status.js"
import { getSuggestedConnectorSyncTarget } from "../../models/connector-sync-target.js"
import { listOrgConnections } from "../../models/org-connections.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ConnectorsListErrorResponse")

const ConnectorListItemSchema = z
  .object({
    id: z.string(),
    type: z.enum([
      "github",
      "forge",
      "slack",
      "linear",
      "notion",
      "pagerduty",
      "buildkite",
      "plain",
    ]),
    /** The account, site, or workspace name that the provider gives. */
    displayName: z.string().nullable(),
    /**
     * The health of the connection from its stored row: a revoked or
     * uninstalled connection needs a reconnect, and a connection that is not
     * installed has an unfinished setup.
     */
    status: z.enum(CONNECTION_STATUSES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("ConnectorListItem")

const ListConnectorsResponseSchema = z
  .object({
    items: z.array(ConnectorListItemSchema),
  })
  .openapi("ListConnectorsResponse")

const listConnectorsRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ListConnectorsResponseSchema,
        },
      },
      description:
        "List connector connections for the org (metadata only; no secrets)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const suggestedSyncTargetRoute = createRoute({
  method: "get",
  path: "/suggested-sync-target",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            target: z
              .object({
                repositoryId: z.string(),
                repositoryName: z.string(),
                gitUrl: z.string(),
                branch: z.string(),
                githubConnectionId: z.string(),
                usedBy: z.array(
                  z.enum(["confluence", "notion", "linear", "slack"]),
                ),
              })
              .nullable(),
          }),
        },
      },
      description: "Recommend a context repository from existing connectors",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

export const connectorsListRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listConnectorsRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)

    const rows = await listOrgConnections(orgId)
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          type: r.type,
          displayName: r.displayName,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
      200,
    )
  })
  .openapi(suggestedSyncTargetRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)

    return c.json({ target: await getSuggestedConnectorSyncTarget(orgId) }, 200)
  })
