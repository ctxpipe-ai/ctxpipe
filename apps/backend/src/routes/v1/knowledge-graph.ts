import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { withOrgDbContext } from "../../db/client.js"
import { computeKnowledgeGraphQuality } from "../../domain/knowledgeGraphQuality.js"
import { getKnowledgeGraphSnapshot } from "../../domain/knowledgeGraphSnapshot.js"
import { getLogger } from "../../observability/logger.js"
import {
  applyIngestionRetractionGraphEffects,
  retractConnectorPrefixInstructionUnitsPg,
} from "../../retrieval/services/ingestionRetraction.js"

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

const KnowledgeGraphQualitySchema = z
  .object({
    totalObjects: z.number().int(),
    totalClaims: z.number().int(),
    multiSourceObjects: z.number().int(),
    joinDensity: z.number(),
    orphanObjects: z.number().int(),
    orphanRate: z.number(),
    evidenceRowsPerClaim: z.number(),
    connectorInstructionUnits: z.number().int(),
    kinds: z.record(z.string(), z.number().int()),
    predicates: z.record(z.string(), z.number().int()),
  })
  .openapi("KnowledgeGraphQuality")

export const getKnowledgeGraphQualityRoute = createRoute({
  method: "get",
  path: "/quality",
  summary: "Graph health metrics (join density, orphans, evidence per claim)",
  responses: {
    200: {
      content: { "application/json": { schema: KnowledgeGraphQualitySchema } },
      description: "Postgres-derived graph quality metrics for the current org",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const RetractConnectorInstructionsResponseSchema = z
  .object({
    unitsDeleted: z.number().int(),
    claimsDeleted: z.number().int(),
    deletedEvidenceRows: z.number().int(),
    orphanObjectsDeleted: z.number().int(),
    graphEdgesDeleted: z.number().int(),
    graphOrphanObjectsDeleted: z.number().int(),
  })
  .openapi("RetractConnectorInstructionsResponse")

export const retractConnectorInstructionsRoute = createRoute({
  method: "post",
  path: "/retract-connector-instructions",
  summary:
    "Remove legacy InstructionUnits minted from connector Markdown (ADR-033 migration)",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RetractConnectorInstructionsResponseSchema,
        },
      },
      description: "Cleanup statistics",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

/** Org-admin maintenance actions; mounted under an admin-scoped path. */
export const knowledgeGraphMaintenanceRoutes =
  new OpenAPIHono<AppEnv>().openapi(
    retractConnectorInstructionsRoute,
    async (c) => {
      const user = c.get("user")
      const session = c.get("session")
      if (!user || !session) {
        return c.json({ error: "Unauthorized" }, 401)
      }
      const orgId = requireCurrentOrgId()
      const result = await withOrgDbContext(orgId, (db) =>
        retractConnectorPrefixInstructionUnitsPg(db, { orgId }),
      )
      const graph = await applyIngestionRetractionGraphEffects(
        result.graphEffects,
      )
      return c.json(
        {
          unitsDeleted: result.unitsDeleted,
          claimsDeleted: result.stats.claimsDeleted,
          deletedEvidenceRows: result.stats.deletedEvidenceRows,
          orphanObjectsDeleted: result.stats.orphanObjectsDeleted,
          graphEdgesDeleted: graph.graphEdgesDeleted,
          graphOrphanObjectsDeleted: graph.graphOrphanObjectsDeleted,
        },
        200,
      )
    },
  )

export const knowledgeGraphRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getKnowledgeGraphQualityRoute, async (c) => {
    // Sessions and org API keys may read quality (the A/B harness uses a key).
    const user = c.get("user")
    const session = c.get("session")
    if (!(user && session) && !c.get("orgApiKey")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = requireCurrentOrgId()
    const quality = await withOrgDbContext(orgId, (db) =>
      computeKnowledgeGraphQuality(db, orgId),
    )
    return c.json(quality, 200)
  })
  .openapi(getKnowledgeGraphRoute, async (c) => {
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
  })
