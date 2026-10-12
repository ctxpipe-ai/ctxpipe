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
    /** Org read only: the workspaces whose projection failed. */
    failedWorkspaces: z
      .array(z.object({ slug: z.string(), name: z.string() }))
      .optional(),
    /** Org read only: the workspaces whose projection is not done yet. */
    pendingWorkspaces: z
      .array(z.object({ slug: z.string(), name: z.string() }))
      .optional(),
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

/** Reads the activity status of one workspace projection. It starts nothing. */
function readProjectionStatus(
  projection: WorkspaceCommitProjectionRecord | null,
): ActivityStatus {
  return projection?.backfillStatus === "ready" ||
    projection?.backfillStatus === "failed"
    ? projection.backfillStatus
    : "pending"
}

/**
 * Reads the status of one workspace projection, and starts a projection run
 * when the projection is missing, not ready, or behind the desired SHA.
 */
function readProjectionStatusAndRefresh(
  workspace: { id: string; orgId: string; desiredSha: string | null },
  projection: WorkspaceCommitProjectionRecord | null,
): ActivityStatus {
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
  return readProjectionStatus(projection)
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
    const status = readProjectionStatusAndRefresh(workspace, projection)
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
        "Commit heatmap and recent commits of every workspace in the org. With `date`, `recent` holds the commits of that UTC day. `ready` when one workspace projection is ready; `pending` only when no projection is ready and one is not done; `failed` only when every projection failed. `failedWorkspaces` and `pendingWorkspaces` list the workspaces whose projection failed or is not done. The read starts at most one projection run per pending workspace in each 5-minute window.",
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
    const rows = (await listOrgWorkspaceCommitProjections()).map((row) => ({
      workspace: row.workspace,
      status: readProjectionStatus(row.projection),
    }))
    // Home polls this read. Start at most one projection run per pending
    // workspace in each 5-minute window.
    const bucket = Math.floor(Date.now() / 300_000)
    for (const row of rows) {
      if (row.status !== "pending") continue
      void enqueueWorkspaceCommitProjection(
        { orgId: row.workspace.orgId, workspaceId: row.workspace.id },
        {
          error: (err) =>
            getLogger().error(err, { step: "org.activity.enqueue" }),
        },
        {
          idempotencyKey: `org-activity-projection:${row.workspace.id}:${bucket}`,
        },
      )
    }
    const statuses = rows.map((row) => row.status)
    // The ready workspaces give the data. Pending only when none is ready.
    const status: ActivityStatus = statuses.includes("ready")
      ? "ready"
      : statuses.includes("pending")
        ? "pending"
        : statuses.length > 0
          ? "failed"
          : "ready"
    const listed = (value: ActivityStatus) =>
      rows
        .filter((row) => row.status === value)
        .map((row) => ({ slug: row.workspace.slug, name: row.workspace.name }))
    const failedWorkspaces = listed("failed")
    const pendingWorkspaces = listed("pending")
    return c.json(
      {
        ...(await activityBody({ status, date })),
        failedWorkspaces,
        pendingWorkspaces,
      },
      200,
    )
  },
)
