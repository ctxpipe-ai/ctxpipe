import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../app/env.js"
import type { Env } from "../../config/env.js"
import {
  listWorkspaceCheckoutPaths,
  readWorkspaceCheckoutFile,
  WorkspaceCheckoutReadError,
} from "../../domain/workspaces/checkout-read.js"
import { fileTreeFromPaths } from "../../domain/workspaces/file-tree.js"
import {
  explorerBlobFromContent,
  explorerBlobFromGitFile,
  explorerBlobPath,
  explorerGitNumstatFromStdout,
  explorerGitStatusFromPorcelain,
  withExplorerGitLineCounts,
  workspaceGitExplorerTarget,
} from "../../domain/workspaces/git-explorer.js"
import {
  parseWorkspaceFileJobRequest,
  planWorkspaceFileJob,
} from "../../domain/workspaces/git-file-jobs.js"
import { getJobSandbox } from "../../domain/workspaces/sandbox-registry.js"
import { writeJobQueueHttpDecision } from "../../domain/workspaces/write-jobs.js"
import {
  getWorkspaceBySlug,
  listWorkspaceKnowledgeFiles,
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

const ExplorerGitStatusSchema = z.enum([
  "added",
  "deleted",
  "ignored",
  "modified",
  "renamed",
  "untracked",
])

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
  .object({ queued: z.literal(true) })
  .openapi("WorkspaceFileJobQueued")

const enqueueWorkspaceFileJobRoute = createRoute({
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
      content: { "application/json": { schema: WorkspaceFileJobQueuedSchema } },
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
})

function resolveWorkspaceGitReadInput(
  workspace: {
    id: string
    workspaceRepositoryUrl: string
    activeProjectionUrl: string | null
    githubConnectionId: string | null
    activeProjectionSha: string | null
    desiredSha: string | null
  },
  orgId: string | null,
  env: Env | undefined,
) {
  if (!orgId || !env) {
    return { ok: false as const, status: 401 as const, error: "Unauthorized" }
  }
  const resolved = workspaceGitExplorerTarget(workspace)
  if (!resolved.ok) return resolved
  return {
    ok: true as const,
    input: {
      workspaceId: workspace.id,
      url: resolved.target.url,
      sha: resolved.target.sha,
    },
  }
}

async function readExplorerTree(input: { workspaceId: string; url: string }) {
  return listWorkspaceCheckoutPaths({
    workspaceId: input.workspaceId,
    gitUrl: input.url,
  })
}

async function readExplorerBlob(input: {
  workspaceId: string
  url: string
  path: string
}) {
  return readWorkspaceCheckoutFile({
    workspaceId: input.workspaceId,
    gitUrl: input.url,
    path: input.path,
  })
}

async function loadWorkspaceGitExplorer(c: Context<AppEnv>) {
  if (!c.get("user") || !c.get("session")) {
    return { ok: false as const, status: 401 as const, error: "Unauthorized" }
  }
  const { workspaceSlug } = workspaceSlugParams(c)
  const workspace = await getWorkspaceBySlug(workspaceSlug)
  if (!workspace) {
    return { ok: false as const, status: 404 as const, error: "Not found" }
  }
  const read = resolveWorkspaceGitReadInput(
    workspace,
    c.get("orgId"),
    c.get("env"),
  )
  if (!read.ok) return read
  return { ok: true as const, workspace, input: read.input }
}

function gitExplorerUpstreamError(error: unknown, step: string) {
  getLogger().error(error instanceof Error ? error : new Error(String(error)), {
    step,
  })
}

function gitExplorerReadFailure(error: unknown, step: string) {
  if (error instanceof WorkspaceCheckoutReadError) {
    return { error: error.message, status: error.status }
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
      const paths = await readExplorerTree(loaded.input)
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
      const file = await readExplorerBlob({
        ...loaded.input,
        path,
      })
      const blob = explorerBlobFromGitFile(file)
      if (!blob) return c.json({ error: "Not found" }, 404)
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
    const sandbox = getJobSandbox(loaded.workspace.id)
    if (!sandbox) {
      return c.json(
        { sha: loaded.input.sha, source: "clean" as const, items: [] },
        200,
      )
    }
    try {
      const status = await sandbox.exec("git status --porcelain", { env: {} })
      if (status.exitCode !== 0) {
        getLogger().error(new Error(status.stderr || "git status failed"), {
          step: "workspace.git_explorer.status",
        })
        return c.json(
          { sha: loaded.input.sha, source: "sandbox" as const, items: [] },
          200,
        )
      }
      const numstat = await sandbox.exec("git diff --numstat HEAD", { env: {} })
      const lineCounts =
        numstat.exitCode === 0
          ? explorerGitNumstatFromStdout(numstat.stdout)
          : new Map()
      const entries = explorerGitStatusFromPorcelain(status.stdout)
      const items = await Promise.all(
        entries.map(async (entry) => {
          if (entry.status === "deleted" || entry.status === "ignored") {
            return withExplorerGitLineCounts(entry, lineCounts)
          }
          try {
            const content = await sandbox.fs.read(entry.path)
            const blob = explorerBlobFromContent(content)
            if (!blob || blob.binary) {
              return withExplorerGitLineCounts(entry, lineCounts)
            }
            return {
              ...withExplorerGitLineCounts(entry, lineCounts, blob.body),
              body: blob.body,
            }
          } catch {
            return withExplorerGitLineCounts(entry, lineCounts)
          }
        }),
      )
      return c.json(
        { sha: loaded.input.sha, source: "sandbox" as const, items },
        200,
      )
    } catch (error) {
      gitExplorerUpstreamError(error, "workspace.git_explorer.status")
      return c.json(
        { sha: loaded.input.sha, source: "sandbox" as const, items: [] },
        200,
      )
    }
  })
  .openapi(enqueueWorkspaceFileJobRoute, async (c) => {
    const loaded = await loadWorkspaceGitExplorer(c)
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status)
    const raw = WorkspaceFileJobRequestSchema.parse(await c.req.json())
    const request = parseWorkspaceFileJobRequest(raw)
    if (!request) return c.json({ error: "A valid file job is required" }, 400)
    const gate = writeJobQueueHttpDecision(loaded.workspace.writeStatus)
    if (!gate.enqueue) return c.json({ error: gate.error }, gate.status)
    try {
      const treePaths = await readExplorerTree(loaded.input)
      const planned = await planWorkspaceFileJob({
        request,
        treePaths,
        readBlob: async (path) => {
          const file = await readExplorerBlob({
            ...loaded.input,
            path,
          })
          return explorerBlobFromGitFile(file)?.body ?? null
        },
      })
      if (!planned.ok) return c.json({ error: planned.error }, 400)
      if (
        planned.plan.mergeFiles.length === 0 &&
        planned.plan.mergeDeletePaths.length === 0
      ) {
        return c.json({ error: "Nothing to write." }, 400)
      }
      void enqueueWorkspaceWriteCommit(
        {
          orgId: loaded.workspace.orgId,
          workspaceId: loaded.workspace.id,
          kind: "ui_file_edit",
          mergeFiles: planned.plan.mergeFiles,
          mergeDeletePaths: planned.plan.mergeDeletePaths,
        },
        c.get("log"),
      )
      return c.json({ queued: true as const }, 202)
    } catch (error) {
      const failure = gitExplorerReadFailure(
        error,
        "workspace.git_explorer.jobs",
      )
      return c.json({ error: failure.error }, failure.status)
    }
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
