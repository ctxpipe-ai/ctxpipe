import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { workspaceGraphFromUnits } from "../../domain/workspaces/workspace-graph.js"
import {
  getWorkspaceBySlug,
  listWorkspaceKnowledgeUnits,
} from "../../models/workspaces.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
  workspaceSlugParams,
} from "./workspace-route-shared.js"

const WorkspaceGraphResponseSchema = z
  .object({
    metrics: z.object({
      totalNodes: z.number().int(),
      totalEdges: z.number().int(),
      lastUpdatedAt: z.string().nullable(),
      nodesReturned: z.number().int(),
      edgesReturned: z.number().int(),
      truncated: z.boolean(),
    }),
    nodes: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string().nullable(),
        summary: z.string().nullable(),
      }),
    ),
    edges: z.array(
      z.object({
        sourceId: z.string(),
        targetId: z.string(),
        predicate: z.string(),
        lastObservedAt: z.string().nullable(),
        confidence: z.number().nullable(),
      }),
    ),
  })
  .openapi("WorkspaceGraphResponse")

const listWorkspaceGraphRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/graph",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceGraphResponseSchema },
      },
      description: "This Workspace’s hydrate projection for the Graph pane",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
  },
})

export const workspaceGraphRoutes = new OpenAPIHono<AppEnv>().openapi(
  listWorkspaceGraphRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const { units, lastUpdatedAt } = await listWorkspaceKnowledgeUnits(
      workspace.id,
    )
    return c.json(workspaceGraphFromUnits({ units, lastUpdatedAt }), 200)
  },
)
