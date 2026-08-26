import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { activityCalendarDays } from "../../domain/workspaces/commit-activity.js"
import {
  getWorkspaceCommitProjection,
  listWorkspaceCommitDayCounts,
  listWorkspaceRepositoryCommits,
} from "../../models/workspace-commits.js"
import { getWorkspaceBySlug } from "../../models/workspaces.js"
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
      }),
    ),
  })
  .openapi("WorkspaceActivityResponse")

const getWorkspaceActivityRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/activity",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceActivityResponseSchema },
      },
      description: "Workspace repository commit heatmap and recent commits",
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

export const workspaceActivityRoutes = new OpenAPIHono<AppEnv>().openapi(
  getWorkspaceActivityRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)

    const [projection, countsByDate, recent] = await Promise.all([
      getWorkspaceCommitProjection(workspace.id),
      listWorkspaceCommitDayCounts(workspace.id),
      listWorkspaceRepositoryCommits({ workspaceId: workspace.id, limit: 5 }),
    ])
    const status =
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
        c.get("log"),
      )
    }

    return c.json(
      {
        status,
        days: activityCalendarDays({ countsByDate }),
        recent: recent.map((row) => ({
          sha: row.sha,
          subject: row.subject,
          authorName: row.authorName,
          committedAt: row.committedAt.toISOString(),
          htmlUrl: row.htmlUrl,
        })),
      },
      200,
    )
  },
)
