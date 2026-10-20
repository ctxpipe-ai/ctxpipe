import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../app/env.js"
import { directWriteRoute } from "../../auth/write-grant.js"
import { CodesearchCheckoutError } from "../../domain/codeIngestion/codesearchClient.js"
import {
  listWorkspaceCheckoutPaths,
  readWorkspaceCheckoutFile,
} from "../../domain/workspaces/checkout-read.js"
import { fileTreeFromPaths } from "../../domain/workspaces/file-tree.js"
import {
  EXPLORER_GIT_STATUSES,
  explorerBlobFromGitFile,
  explorerBlobPath,
} from "../../domain/workspaces/git-explorer.js"
import {
  parseWorkspaceFileJobRequest,
  planWorkspaceFileJob,
} from "../../domain/workspaces/git-file-jobs.js"
import { LEGACY_KNOWLEDGE_READ_ONLY } from "../../domain/workspaces/legacy-knowledge-overlay.js"
import { publishedProjection } from "../../domain/workspaces/revision.js"
import { workspaceRootPath } from "../../domain/workspaces/root-path.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  WRITE_JOB_STATUSES,
  type WriteJobStatus,
} from "../../domain/workspaces/write-job-intent.js"
import { generateObjectId } from "../../lib/id.js"
import { getWorkspaceFileJobStatus } from "../../models/workspace-write-jobs.js"
import {
  getWorkspaceBySlug,
  getWorkspaceSearchProjection,
  legacyKnowledgePaths,
  listWorkspaceKnowledgeFiles,
  writesLegacyKnowledge,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
  workspaceSlugParams,
} from "./workspace-route-shared.js"

const WorkspaceFileSchema = z
  .object({
    path: z.string(),
    body: z.string(),
  })
  .openapi("WorkspaceFile")

const WorkspaceFileTreeNodeSchema: z.ZodType<{
  name: string
  path: string
  children?: Array<{ name: string; path: string; children?: unknown[] }>
}> = z
  .object({
    name: z.string(),
    path: z.string(),
    children: z.array(z.lazy(() => WorkspaceFileTreeNodeSchema)).optional(),
  })
  .openapi("WorkspaceFileTreeNode")

const WorkspaceFilesResponseSchema = z
  .object({
    items: z.array(WorkspaceFileSchema),
    tree: z.array(WorkspaceFileTreeNodeSchema),
  })
  .openapi("WorkspaceFilesResponse")

const listWorkspaceFilesRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/files",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceFilesResponseSchema },
      },
      description: "Hydrated knowledge files for Graph and search",
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

const WorkspaceGitTreeResponseSchema = z
  .object({
    sha: z.string(),
    paths: z.array(z.string()),
  })
  .openapi("WorkspaceGitTreeResponse")

const listWorkspaceGitTreeRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/files/tree",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceGitTreeResponseSchema },
      },
      description: "Git tree at the Workspace projection SHA",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Cannot browse this Workspace repository",
    },
    502: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Checkout read failed",
    },
  },
})

const WorkspaceGitBlobQuerySchema = z
  .object({
    path: z.string().min(1),
  })
  .openapi("WorkspaceGitBlobQuery")

const WorkspaceGitBlobResponseSchema = z
  .object({
    path: z.string(),
    body: z.string().nullable(),
    binary: z.boolean(),
    readOnlyReason: z.string().optional().openapi({
      description:
        "Set when the file is knowledge from before Workspaces that is not in git. It cannot be edited.",
    }),
  })
  .openapi("WorkspaceGitBlobResponse")

const getWorkspaceGitBlobRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/files/blob",
  request: {
    params: WorkspaceSlugParamsSchema,
    query: WorkspaceGitBlobQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceGitBlobResponseSchema },
      },
      description: "File contents at the Workspace projection SHA",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid path",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Cannot browse this Workspace repository",
    },
    502: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Checkout read failed",
    },
  },
})

const ExplorerGitStatusSchema = z.enum(EXPLORER_GIT_STATUSES)

const WorkspaceGitStatusItemSchema = z
  .object({
    path: z.string(),
    status: ExplorerGitStatusSchema,
    body: z.string().nullable().optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
  })
  .openapi("WorkspaceGitStatusItem")

const WorkspaceGitStatusResponseSchema = z
  .object({
    sha: z.string(),
    source: z.enum(["sandbox", "clean"]),
    items: z.array(WorkspaceGitStatusItemSchema),
  })
  .openapi("WorkspaceGitStatusResponse")

const listWorkspaceGitStatusRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/files/status",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceGitStatusResponseSchema },
      },
      description: "Git status vs HEAD for the Files pane",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Cannot browse this Workspace repository",
    },
  },
})

const WorkspaceFileJobRequestSchema = z
  .object({
    op: z.enum(["save", "create", "rename", "move", "delete"]),
    path: z.string().min(1).optional(),
    content: z.string().optional(),
    kind: z.enum(["file", "folder"]).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    toDirectory: z.string().nullable().optional(),
  })
  .openapi("WorkspaceFileJobRequest")

const WorkspaceFileJobQueuedSchema = z
  .object({
    queued: z.literal(true),
    jobId: z.string().openapi({
      description: "Read its status at `GET …/files/jobs/{jobId}`.",
    }),
  })
  .openapi("WorkspaceFileJobQueued")

const WorkspaceFileJobParamsSchema = WorkspaceSlugParamsSchema.extend({
  jobId: z.string().min(1),
}).openapi("WorkspaceFileJobParams")

const WorkspaceFileJobStatusSchema = z
  .object({
    status: z
      .enum(
        Object.values(WRITE_JOB_STATUSES) as [
          WriteJobStatus,
          ...WriteJobStatus[],
        ],
      )
      .openapi({
        description:
          "`queued`, `running` and `paused`: the write is not done. `completed`: the write is on the default branch. `failed`: the write is lost and does not retry; send the edit again as a new job.",
      }),
    failureReason: z.string().nullable().openapi({
      description:
        "Why the job failed, when the reason is known. For example `superseded`: the Workspace repository changed before the write.",
    }),
  })
  .openapi("WorkspaceFileJobStatus")

const getWorkspaceFileJobRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/files/jobs/{jobId}",
  request: { params: WorkspaceFileJobParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceFileJobStatusSchema },
      },
      description: "Status of a Files pane write job",
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

const enqueueWorkspaceFileJobRoute = createRoute(
  directWriteRoute({
    method: "post",
    path: "/{workspaceSlug}/files/jobs",
    request: {
      params: WorkspaceSlugParamsSchema,
      body: {
        content: {
          "application/json": { schema: WorkspaceFileJobRequestSchema },
        },
      },
    },
    responses: {
      202: {
        content: {
          "application/json": { schema: WorkspaceFileJobQueuedSchema },
        },
        description: "Files pane write queued",
      },
      400: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Invalid request or read-only Workspace",
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Unauthorized",
      },
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Not found",
      },
      409: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Write status unknown or cannot browse git",
      },
      502: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Checkout read failed",
      },
    },
  }),
)

async function loadWorkspaceGitExplorer(c: Context<AppEnv>) {
  if (!c.get("user") || !c.get("session")) {
    return { ok: false as const, status: 401 as const, error: "Unauthorized" }
  }
  const { workspaceSlug } = workspaceSlugParams(c)
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) {
    return { ok: false as const, status: 404 as const, error: "Not found" }
  }
  const snapshot = await getWorkspaceSearchProjection(workspace.id)
  const projection = publishedProjection(snapshot.projection)
  const published =
    projection?.kind === "active" ? projection.stores.index.published : null
  const repository = published
    ? snapshot.repositories.find(
        (repo) =>
          repo.sha === published.sha &&
          normalizeWorkspaceRepositoryUrl(repo.gitUrl) ===
            normalizeWorkspaceRepositoryUrl(published.remote.url),
      )
    : null
  if (!published || !repository)
    return {
      ok: false as const,
      status: 409 as const,
      error:
        "This Workspace must finish indexing before its published files can be browsed.",
    }
  return {
    ok: true as const,
    workspace,
    input: {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      sha: published.sha,
      rootPath: workspaceRootPath(published),
    },
  }
}

function gitExplorerUpstreamError(error: unknown, step: string) {
  getLogger().error(error instanceof Error ? error : new Error(String(error)), {
    step,
  })
}

function gitExplorerReadFailure(error: unknown, step: string) {
  if (error instanceof CodesearchCheckoutError) {
    return {
      error: error.message,
      status: (error.status === 404 || error.status === 409
        ? error.status
        : 502) as 404 | 409 | 502,
    }
  }
  gitExplorerUpstreamError(error, step)
  return {
    error: "Could not read this Workspace repository.",
    status: 502 as const,
  }
}

export const workspaceFilesRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listWorkspaceGitTreeRoute, async (c) => {
    const loaded = await loadWorkspaceGitExplorer(c)
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status)
    try {
      const paths = await listWorkspaceCheckoutPaths(loaded.input)
      return c.json(
        {
          sha: loaded.input.sha,
          paths,
        },
        200,
      )
    } catch (error) {
      const failure = gitExplorerReadFailure(
        error,
        "workspace.git_explorer.tree",
      )
      return c.json({ error: failure.error }, failure.status)
    }
  })
  .openapi(getWorkspaceGitBlobRoute, async (c) => {
    const path = explorerBlobPath(c.req.query("path") ?? "")
    if (!path) return c.json({ error: "A valid file path is required" }, 400)
    const loaded = await loadWorkspaceGitExplorer(c)
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status)
    try {
      const file = await readWorkspaceCheckoutFile({
        ...loaded.input,
        path,
      })
      const blob = explorerBlobFromGitFile(file)
      if (!blob) {
        // A main-era knowledge unit that hydrate serves from Postgres.
        const legacy = (
          await legacyKnowledgePaths(loaded.workspace.id, [path])
        ).get(path)
        if (legacy === undefined) return c.json({ error: "Not found" }, 404)
        return c.json(
          {
            path,
            body: legacy,
            binary: false,
            readOnlyReason: LEGACY_KNOWLEDGE_READ_ONLY,
          },
          200,
        )
      }
      return c.json({ path, ...blob }, 200)
    } catch (error) {
      const failure = gitExplorerReadFailure(
        error,
        "workspace.git_explorer.blob",
      )
      return c.json({ error: failure.error }, failure.status)
    }
  })
  .openapi(listWorkspaceGitStatusRoute, async (c) => {
    const loaded = await loadWorkspaceGitExplorer(c)
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status)
    return c.json(
      { sha: loaded.input.sha, source: "clean" as const, items: [] },
      200,
    )
  })
  .openapi(enqueueWorkspaceFileJobRoute, async (c) => {
    const loaded = await loadWorkspaceGitExplorer(c)
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status)
    const raw = WorkspaceFileJobRequestSchema.parse(await c.req.json())
    const request = parseWorkspaceFileJobRequest(raw)
    if (!request) return c.json({ error: "A valid file job is required" }, 400)
    try {
      const treePaths = await listWorkspaceCheckoutPaths(loaded.input)
      const planned = await planWorkspaceFileJob({
        request,
        treePaths,
        readBlob: async (path) => {
          const file = await readWorkspaceCheckoutFile({
            ...loaded.input,
            path,
          })
          return explorerBlobFromGitFile(file)?.body ?? null
        },
      })
      // A main-era knowledge unit is not in git: it is read-only. The check
      // reads the paths that the job writes, and the paths of the request.
      if (
        await writesLegacyKnowledge(loaded.workspace.id, [
          raw.path,
          raw.from,
          raw.to,
          ...(planned.ok
            ? [
                ...planned.plan.mergeFiles.map((file) => file.path),
                ...planned.plan.mergeDeletePaths,
              ]
            : []),
        ])
      )
        return c.json({ error: LEGACY_KNOWLEDGE_READ_ONLY }, 400)
      if (!planned.ok) return c.json({ error: planned.error }, 400)
      if (
        planned.plan.mergeFiles.length === 0 &&
        planned.plan.mergeDeletePaths.length === 0
      ) {
        return c.json({ error: "Nothing to write." }, 400)
      }
      const jobId = generateObjectId("wjob")
      const admitted = await enqueueWorkspaceWriteCommit(
        {
          jobId,
          orgId: loaded.workspace.orgId,
          workspaceId: loaded.workspace.id,
          kind: "ui_file_edit",
          mergeFiles: planned.plan.mergeFiles,
          mergeDeletePaths: planned.plan.mergeDeletePaths,
        },
        c.get("log"),
      )
      if (!admitted.started)
        return c.json(
          {
            error:
              "The write could not be queued. Refresh the Workspace and try again.",
          },
          409,
        )
      return c.json({ queued: true as const, jobId }, 202)
    } catch (error) {
      const failure = gitExplorerReadFailure(
        error,
        "workspace.git_explorer.jobs",
      )
      return c.json({ error: failure.error }, failure.status)
    }
  })
  .openapi(getWorkspaceFileJobRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug, jobId } = WorkspaceFileJobParamsSchema.parse(
      c.req.param(),
    )
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const job = await getWorkspaceFileJobStatus(workspace.id, jobId)
    if (!job) return c.json({ error: "Not found" }, 404)
    return c.json(
      {
        status: job.status as WriteJobStatus,
        failureReason: job.failureReason,
      },
      200,
    )
  })
  .openapi(listWorkspaceFilesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const items = await listWorkspaceKnowledgeFiles(workspace.id)
    return c.json(
      {
        items,
        tree: fileTreeFromPaths(items.map((item) => item.path)),
      },
      200,
    )
  })
