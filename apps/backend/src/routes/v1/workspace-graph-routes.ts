import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import type { AppEnv } from "../../app/env.js"
import { hydrateUnitsToProjectionClaims } from "../../domain/workspaces/hydrate.js"
import { computeWorkspaceGraphQuality } from "../../domain/workspaces/workspace-graph.js"
import { planeKnowledgeReader } from "../../knowledge-reader/plane-reader.js"
import { readyKnowledgeHeads } from "../../models/knowledge-state.js"
import {
  getWorkspaceBySlug,
  getWorkspaceProjectionSnapshot,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
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
        path: z.string(),
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
    202: {
      content: {
        "application/json": {
          schema: z.object({ building: z.literal(true) }),
        },
      },
      description:
        "The graph of the active revision is building; read again later",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Derived graph unavailable",
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

const WorkspaceGraphQualityResponseSchema = z
  .object({
    totalUnits: z.number().int(),
    totalClaims: z.number().int(),
    multiSourceUnits: z.number().int(),
    joinDensity: z.number(),
    orphanUnits: z.number().int(),
    orphanRate: z.number(),
    sourcedClaimRate: z.number(),
    kinds: z.record(z.string(), z.number().int()),
    predicates: z.record(z.string(), z.number().int()),
  })
  .openapi("WorkspaceGraphQualityResponse")

const workspaceGraphQualityRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/graph/quality",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceGraphQualityResponseSchema },
      },
      description:
        "Graph health of this Workspace’s active projection (ADR-033 join density)",
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

export const workspaceGraphRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listWorkspaceGraphRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    try {
      const heads = await readyKnowledgeHeads(workspace.orgId, [workspace.id])
      // The pane shows its building state until the plane serves the
      // Workspace.
      if (!heads.has(workspace.id))
        return c.json({ building: true as const }, 202)
      return c.json(
        await planeKnowledgeReader({ heads }).graph({
          orgId: workspace.orgId,
          workspaceId: workspace.id,
        }),
        200,
      )
    } catch (error) {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "workspace.graph.read" },
      )
      return c.json(
        { error: "Workspace graph projection is unavailable." },
        503,
      )
    }
  })
  .openapi(workspaceGraphQualityRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const { units } = await getWorkspaceProjectionSnapshot(workspace.id)
    return c.json(
      computeWorkspaceGraphQuality(
        units,
        hydrateUnitsToProjectionClaims(units),
      ),
      200,
    )
  })
