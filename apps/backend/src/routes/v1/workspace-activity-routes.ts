import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { activityCalendarDays } from "../../domain/workspaces/commit-activity.js"
import {
  getWorkspaceCommitProjection,
  listOrgWorkspaceCommitProjections,
  listWorkspaceCommitDayCounts,
  listWorkspaceRepositoryCommits,
  type WorkspaceCommitProjectionRecord,
} from "../../models/workspace-commits.js"
import { getWorkspaceBySlug } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkspaceCommitProjection } from "../../openworkflow/enqueue-workspace-commit-projection.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
  workspaceSlugParams,
} from "./workspace-route-shared.js"

const WorkspaceActivityResponseSchema = z
  .object({
    status: z.enum(["pending", "ready", "failed"]),
    days: z.array(
      z.object({
        date: z.string(),
        count: z.number().int(),
      }),
    ),
    recent: z.array(
      z.object({
        sha: z.string(),
        subject: z.string(),
        authorName: z.string(),
        committedAt: z.string().datetime(),
        htmlUrl: z.string().nullable(),
        workspaceSlug: z.string(),
        workspaceName: z.string(),
      }),
    ),
  })
  .openapi("WorkspaceActivityResponse")

const WorkspaceActivityQuerySchema = z.object({
  /** One UTC day (`YYYY-MM-DD`). `recent` then holds the commits of that day. */
  date: z.iso.date().optional(),
})

const getWorkspaceActivityRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/activity",
  request: {
    params: WorkspaceSlugParamsSchema,
    query: WorkspaceActivityQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceActivityResponseSchema },
      },
      description:
        "Workspace repository commit heatmap and recent commits. With `date`, `recent` holds the commits of that UTC day.",
    },
    400: {
      description: "Invalid query parameter",
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

type ActivityStatus = "pending" | "ready" | "failed"

/**
 * The status of one workspace projection. A projection that is missing, not
 * ready, or behind the desired SHA starts a projection run.
 */
function projectionStatus(
  workspace: { id: string; orgId: string; desiredSha: string | null },
  projection: WorkspaceCommitProjectionRecord | null,
): ActivityStatus {
  const status: ActivityStatus =
    projection?.backfillStatus === "ready" ||
    projection?.backfillStatus === "failed"
      ? projection.backfillStatus
      : "pending"
  const stale =
    !projection ||
    projection.backfillStatus !== "ready" ||
    (workspace.desiredSha != null &&
      projection.headSha !== workspace.desiredSha)
  if (stale) {
    void enqueueWorkspaceCommitProjection(
      { orgId: workspace.orgId, workspaceId: workspace.id },
      {
        error: (err) =>
          getLogger().error(err, { step: "workspace.activity.enqueue" }),
      },
    )
  }
  return status
}

async function activityBody(input: {
  status: ActivityStatus
  workspaceId?: string
  date?: string
}) {
  const [countsByDate, recent] = await Promise.all([
    listWorkspaceCommitDayCounts(input.workspaceId),
    listWorkspaceRepositoryCommits({
      workspaceId: input.workspaceId,
      date: input.date,
      limit: input.date ? 50 : 5,
    }),
  ])
  return {
    status: input.status,
    days: activityCalendarDays({ countsByDate }),
    recent: recent.map((row) => ({
      sha: row.sha,
      subject: row.subject,
      authorName: row.authorName,
      committedAt: row.committedAt.toISOString(),
      htmlUrl: row.htmlUrl,
      workspaceSlug: row.workspaceSlug,
      workspaceName: row.workspaceName,
    })),
  }
}

export const workspaceActivityRoutes = new OpenAPIHono<AppEnv>().openapi(
  getWorkspaceActivityRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const { date } = c.req.valid("query")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)

    const projection = await getWorkspaceCommitProjection(workspace.id)
    const status = projectionStatus(workspace, projection)
    return c.json(
      await activityBody({ status, workspaceId: workspace.id, date }),
      200,
    )
  },
)

const getOrgActivityRoute = createRoute({
  method: "get",
  path: "/",
  request: { query: WorkspaceActivityQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceActivityResponseSchema },
      },
      description:
        "Commit heatmap and recent commits of every workspace in the org. With `date`, `recent` holds the commits of that UTC day. `pending` while a workspace projection is not done; `failed` only when every projection failed.",
    },
    400: {
      description: "Invalid query parameter",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

export const orgActivityRoutes = new OpenAPIHono<AppEnv>().openapi(
  getOrgActivityRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { date } = c.req.valid("query")
    const statuses = (await listOrgWorkspaceCommitProjections()).map((row) =>
      projectionStatus(row.workspace, row.projection),
    )
    const status: ActivityStatus = statuses.includes("pending")
      ? "pending"
      : statuses.length > 0 && statuses.every((value) => value === "failed")
        ? "failed"
        : "ready"
    return c.json(await activityBody({ status, date }), 200)
  },
)
