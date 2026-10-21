import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  countActiveIngestion,
  INGESTION_STAGES,
  listActiveIngestion,
} from "../../models/workspace-ingestion.js"
import {
  getWorkspaceBySlug,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
} from "./workspace-route-shared.js"

const IngestionItemSchema = z
  .object({
    id: z.string().openapi({ description: "The workflow run." }),
    kind: z.enum(["repository", "source_sync", "reingest", "hydrate"]).openapi({
      description:
        "`repository`: an ingestion run of a source repository. `source_sync`: a sync of the sources of a connection. `reingest`: an upgrade re-ingestion. `hydrate`: ctxpipe reads the newest commit of the Workspace; only when it takes longer than 30 s.",
    }),
    name: z.string().openapi({
      description:
        "`owner/name` of a repository, the provider of a sync, or the upgrade key of a re-ingestion.",
    }),
    stage: z.enum(INGESTION_STAGES).openapi({
      description:
        "`waiting`: the run waits for an earlier run of the same repository. The other stages tell what the run does now.",
    }),
    progress: z
      .object({
        done: z.number().int(),
        total: z.number().int(),
        unit: z.enum(["shards", "repositories"]),
      })
      .nullable()
      .openapi({ description: "How far the run is. Null when not known." }),
    startedAt: z.string().openapi({ description: "When the run was queued." }),
  })
  .openapi("ActiveIngestionItem")

const WorkspaceIngestionSchema = z
  .object({ items: z.array(IngestionItemSchema) })
  .openapi("WorkspaceIngestion")

const OrgIngestionSchema = z
  .object({
    workspaces: z.array(
      z.object({
        workspaceSlug: z.string(),
        sources: z.number().int().openapi({
          description:
            "The count of runs that ingest or sync a source of the Workspace now.",
        }),
        hydrating: z.boolean().openapi({
          description:
            "True when ctxpipe reads the newest commit of the Workspace and it takes longer than 30 s.",
        }),
      }),
    ),
  })
  .openapi("OrgWorkspaceIngestion")

const getWorkspaceIngestionRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/ingestion",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkspaceIngestionSchema } },
      description:
        "The ingestion work that runs now for the Workspace, oldest first. Every member can read it. The read writes nothing.",
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

/** The ingestion work of one Workspace, for Workspace settings (CTX-959). */
export const workspaceIngestionRoutes = new OpenAPIHono<AppEnv>().openapi(
  getWorkspaceIngestionRoute,
  async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const workspace = await getWorkspaceBySlug(
      c.req.valid("param").workspaceSlug,
    )
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const items = await listActiveIngestion(orgId, [workspace.id])
    return c.json({ items: items.get(workspace.id) ?? [] }, 200)
  },
)

const getOrgIngestionRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: { "application/json": { schema: OrgIngestionSchema } },
      description:
        "The Workspaces of the org that have ingestion work now, each with the count of its work. A Workspace with no work is not in the list. Every member can read it. The read writes nothing.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

/** One read for all the Workspaces of the org, for the sidebar (CTX-959). */
export const orgWorkspaceIngestionRoutes = new OpenAPIHono<AppEnv>().openapi(
  getOrgIngestionRoute,
  async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const workspaces = await listOrgWorkspaces(orgId)
    const counts = await countActiveIngestion(
      orgId,
      workspaces.map((workspace) => workspace.id),
    )
    return c.json(
      {
        workspaces: workspaces.flatMap((workspace) => {
          const count = counts.get(workspace.id)
          return count && (count.sources || count.hydrating)
            ? [{ workspaceSlug: workspace.slug, ...count }]
            : []
        }),
      },
      200,
    )
  },
)
