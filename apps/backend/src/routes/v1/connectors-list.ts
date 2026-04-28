import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { listOrgConnections } from "../../models/org-connections.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ConnectorsListErrorResponse")

const ConnectorListItemSchema = z
  .object({
    id: z.string(),
    type: z.enum(["github", "forge"]),
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
      description: "List connector connections for the org (metadata only; no secrets)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

export const connectorsListRoutes = new OpenAPIHono<AppEnv>().openapi(
  listConnectorsRoute,
  async (c) => {
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
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
      200,
    )
  },
)
