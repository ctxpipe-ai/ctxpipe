import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { activityCalendarDays } from "../../domain/workspaces/commit-activity.js"
import {
  getWorkspaceCommitProjection,
  listOrgWorkspaceCommitProjections,
  listWorkspaceCommitAuthors,
  listWorkspaceCommitDayCounts,
  listWorkspaceRepositoryCommits,
  type WorkspaceCommitListFilters,
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
        /** The GitHub login of the author. `null`: no GitHub user. */
        authorLogin: z.string().nullable().optional(),
        committedAt: z.string().datetime(),
        htmlUrl: z.string().nullable(),
        workspaceSlug: z.string(),
        workspaceName: z.string(),
      }),
    ),
    /** The authors of the commits in the heatmap window, most active first. */
    authors: z.array(
      z.object({
        name: z.string(),
        count: z.number().int(),
        /** One GitHub login of the author. `null`: no GitHub user. */
        login: z.string().nullable().optional(),
      }),
    ),
    /** Send as `cursor` to read the next page of `recent`. `null`: no more commits. */
    nextCursor: z.string().nullable(),
    /** Org read only: the workspaces whose projection is not done yet. */
    pendingWorkspaces: z
      .array(z.object({ slug: z.string(), name: z.string() }))
      .optional(),
  })
  .openapi("WorkspaceActivityResponse")

const WorkspaceActivityQuerySchema = z.object({
  /** One UTC day (`YYYY-MM-DD`). `recent` then holds the commits of that day. */
  date: z.iso.date().optional(),
  /** Only the commits of this author name. */
  author: z.string().min(1).max(200).optional(),
  /** The first UTC day (`YYYY-MM-DD`, inclusive) of `recent`. */
  since: z.iso.date().optional(),
  /** The last UTC day (`YYYY-MM-DD`, inclusive) of `recent`. */
  until: z.iso.date().optional(),
  /** The `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(512).optional(),
  /** The page size of `recent`. Default: 5, or 50 with `date`. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/** The cursor holds the last row of a page: commit time, SHA, workspace id. */
function encodeCursor(row: {
  committedAt: Date
  sha: string
  workspaceId: string
}): string {
  return Buffer.from(
    JSON.stringify([row.committedAt.toISOString(), row.sha, row.workspaceId]),
  ).toString("base64url")
}

function decodeCursor(cursor: string): WorkspaceCommitListFilters["after"] {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    )
    const parsed = z
      .tuple([z.string(), z.string(), z.string()])
      .safeParse(value)
    if (parsed.success) {
      const [time, sha, workspaceId] = parsed.data
      const committedAt = new Date(time)
      if (!Number.isNaN(committedAt.getTime()))
        return { committedAt, sha, workspaceId }
    }
  } catch {
    // A cursor that does not decode is a bad request.
  }
  return undefined
}

type ActivityQuery = z.infer<typeof WorkspaceActivityQuerySchema>

/** The list filters of a query, or `null` when the cursor does not decode. */
function listFilters(query: ActivityQuery): WorkspaceCommitListFilters | null {
  const after = query.cursor ? decodeCursor(query.cursor) : undefined
  if (query.cursor && !after) return null
  return {
    author: query.author,
    since: query.since,
    until: query.until,
    after,
  }
}

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
        "Workspace repository commit heatmap and recent commits. With `date`, `recent` holds the commits of that UTC day. `author`, `since`, and `until` filter `recent`; `cursor` and `limit` page it.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
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
 * Home polls the activity reads. Start at most one projection run per
 * workspace state (desired SHA and projection status) in each 5-minute window.
 */
function enqueueProjectionOncePerWindow(
  workspace: { id: string; orgId: string; desiredSha: string | null },
  projection: WorkspaceCommitProjectionRecord | null,
  step: string,
) {
  const state = `${workspace.desiredSha ?? "none"}:${projection?.backfillStatus ?? "none"}`
  void enqueueWorkspaceCommitProjection(
    { orgId: workspace.orgId, workspaceId: workspace.id },
    { error: (err) => getLogger().error(err, { step }) },
    {
      idempotencyKey: `activity-projection:${workspace.id}:${state}:${Math.floor(Date.now() / 300_000)}`,
    },
  )
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
  if (stale)
    enqueueProjectionOncePerWindow(
      workspace,
      projection,
      "workspace.activity.enqueue",
    )
  return readProjectionStatus(projection)
}

async function activityBody(input: {
  status: ActivityStatus
  workspaceId?: string
  date?: string
  limit?: number
  filters: WorkspaceCommitListFilters
}) {
  const limit = input.limit ?? (input.date ? 50 : 5)
  const [countsByDate, authors, rows] = await Promise.all([
    listWorkspaceCommitDayCounts(input.workspaceId),
    listWorkspaceCommitAuthors(input.workspaceId),
    // One more row than the page tells if a next page exists.
    listWorkspaceRepositoryCommits({
      workspaceId: input.workspaceId,
      date: input.date,
      limit: limit + 1,
      filters: input.filters,
    }),
  ])
  const recent = rows.slice(0, limit)
  const last = recent.at(-1)
  return {
    status: input.status,
    days: activityCalendarDays({ countsByDate }),
    authors,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    recent: recent.map((row) => ({
      sha: row.sha,
      subject: row.subject,
      authorName: row.authorName,
      // "" (no GitHub user) and null (not read yet) both give no avatar.
      authorLogin: row.authorLogin || null,
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
    const query = c.req.valid("query")
    const filters = listFilters(query)
    if (!filters) return c.json({ error: "Invalid cursor" }, 400)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)

    const projection = await getWorkspaceCommitProjection(workspace.id)
    const status = readProjectionStatusAndRefresh(workspace, projection)
    return c.json(
      await activityBody({
        status,
        workspaceId: workspace.id,
        date: query.date,
        limit: query.limit,
        filters,
      }),
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
        "Commit heatmap and recent commits of every workspace in the org. With `date`, `recent` holds the commits of that UTC day. `author`, `since`, and `until` filter `recent`; `cursor` and `limit` page it. `ready` when one workspace projection is ready; `pending` only when no projection is ready and one is not done; `failed` only when every projection failed. `pendingWorkspaces` lists the workspaces whose projection is not done. The response does not name a workspace whose projection failed; the projection run logs the failure. The read starts at most one projection run per pending workspace in each 5-minute window.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
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
    const query = c.req.valid("query")
    const filters = listFilters(query)
    if (!filters) return c.json({ error: "Invalid cursor" }, 400)
    const rows = (await listOrgWorkspaceCommitProjections()).map((row) => ({
      ...row,
      status: readProjectionStatus(row.projection),
    }))
    for (const row of rows) {
      if (row.status === "pending")
        enqueueProjectionOncePerWindow(
          row.workspace,
          row.projection,
          "org.activity.enqueue",
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
    const pendingWorkspaces = rows
      .filter((row) => row.status === "pending")
      .map((row) => ({ slug: row.workspace.slug, name: row.workspace.name }))
    return c.json(
      {
        ...(await activityBody({
          status,
          date: query.date,
          limit: query.limit,
          filters,
        })),
        pendingWorkspaces,
      },
      200,
    )
  },
)
