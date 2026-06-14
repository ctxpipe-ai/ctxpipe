import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { getKnowledgeGraphReview } from "../../domain/knowledgeGraphReview.js"
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

const KnowledgeGraphReviewObjectSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string().nullable(),
  summary: z.string().nullable(),
})

const KnowledgeGraphReviewEvidenceSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  sourceUrl: z.string().nullable(),
  sourceLink: z.string(),
  extractionMethod: z.string(),
  confidence: z.number(),
  observedAt: z.string(),
})

const KnowledgeGraphReviewResponseSchema = z
  .object({
    total: z.number().int(),
    confidenceBelow: z.number(),
    limit: z.number().int(),
    items: z.array(
      z.object({
        id: z.string(),
        predicate: z.string(),
        aggregatedConfidence: z.number(),
        lastObservedAt: z.string(),
        subject: KnowledgeGraphReviewObjectSchema,
        object: KnowledgeGraphReviewObjectSchema,
        evidence: z.array(KnowledgeGraphReviewEvidenceSchema),
      }),
    ),
  })
  .openapi("KnowledgeGraphReviewResponse")

const KnowledgeGraphReviewQuerySchema = z
  .object({
    confidenceBelow: z.coerce.number().min(0).max(1).default(0.7),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi("KnowledgeGraphReviewQuery")

const getKnowledgeGraphRoute = createRoute({
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

const getKnowledgeGraphReviewRoute = createRoute({
  method: "get",
  path: "/review",
  request: {
    query: KnowledgeGraphReviewQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: KnowledgeGraphReviewResponseSchema,
        },
      },
      description: "Low-confidence knowledge graph claims that need review",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
  },
})

export const knowledgeGraphRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getKnowledgeGraphRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const q = KnowledgeGraphQuerySchema.parse({
      nodeLimit: c.req.query("nodeLimit"),
      edgeLimit: c.req.query("edgeLimit"),
    })
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
  })
  .openapi(getKnowledgeGraphReviewRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const q = KnowledgeGraphReviewQuerySchema.parse({
      confidenceBelow: c.req.query("confidenceBelow"),
      limit: c.req.query("limit"),
    })
    const orgId = requireCurrentOrgId()
    const orgSlug = requireCurrentOrgSlug()
    const review = await getKnowledgeGraphReview({
      orgId,
      orgSlug,
      confidenceBelow: q.confidenceBelow,
      limit: q.limit,
    })
    return c.json(review, 200)
  })
