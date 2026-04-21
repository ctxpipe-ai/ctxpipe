import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { getKnowledgeGraphSnapshot } from "../../domain/knowledgeGraphSnapshot.js"
import { getLogger } from "../../observability/logger.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("KnowledgeGraphErrorResponse")

const KnowledgeGraphNodeSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    summary: z.string().nullable(),
  })
  .openapi("KnowledgeGraphNode")

const KnowledgeGraphEdgeSchema = z
  .object({
    sourceId: z.string(),
    targetId: z.string(),
    predicate: z.string(),
    lastObservedAt: z.string().nullable(),
    confidence: z.number().nullable(),
  })
  .openapi("KnowledgeGraphEdge")

const KnowledgeGraphMetricsSchema = z
  .object({
    totalNodes: z.number().int(),
    totalEdges: z.number().int(),
    lastUpdatedAt: z.string().nullable(),
    nodesReturned: z.number().int(),
    edgesReturned: z.number().int(),
    truncated: z.boolean(),
  })
  .openapi("KnowledgeGraphMetrics")

const KnowledgeGraphResponseSchema = z
  .object({
    metrics: KnowledgeGraphMetricsSchema,
    nodes: z.array(KnowledgeGraphNodeSchema),
    edges: z.array(KnowledgeGraphEdgeSchema),
  })
  .openapi("KnowledgeGraphResponse")

const KnowledgeGraphQuerySchema = z
  .object({
    nodeLimit: z.coerce.number().int().min(1).max(500_000).optional(),
    edgeLimit: z.coerce.number().int().min(1).max(1_000_000).optional(),
  })
  .openapi("KnowledgeGraphQuery")

export const getKnowledgeGraphRoute = createRoute({
  method: "get",
  path: "/",
  request: {
    query: KnowledgeGraphQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: KnowledgeGraphResponseSchema,
        },
      },
      description: "Knowledge graph nodes and edges for the current org",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    503: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Graph database unavailable",
    },
  },
})

export const knowledgeGraphRoutes = new OpenAPIHono<AppEnv>().openapi(
  getKnowledgeGraphRoute,
  async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const q = c.req.valid("query")
    const orgId = requireCurrentOrgId()
    const orgSlug = requireCurrentOrgSlug()
    const log = getLogger()

    try {
      const snapshot = await getKnowledgeGraphSnapshot(orgId, orgSlug, {
        nodeLimit: q.nodeLimit,
        edgeLimit: q.edgeLimit,
      })
      return c.json(snapshot, 200)
    } catch (err) {
      log.error(err instanceof Error ? err : new Error(String(err)), {
        step: "knowledgeGraph.snapshot",
        orgId,
      })
      return c.json({ error: "Graph database unavailable" }, 503)
    }
  },
)
