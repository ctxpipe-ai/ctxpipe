import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../app/env.js"
import type { Env } from "../../config/env.js"
import {
  resolveWorkspaceGithubConnectionId,
  type WorkspaceAddSource,
} from "../../domain/workspaces/bind-github-connection.js"
import {
  listWorkspaceCheckoutPaths,
  readWorkspaceCheckoutFile,
  WorkspaceCheckoutReadError,
} from "../../domain/workspaces/checkout-read.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
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
import { shouldHydrateBeforeMigrationExport } from "../../domain/workspaces/hydrate.js"
import {
  destroySandboxesForWorkspace,
  getJobSandbox,
  withDestroyedWorkspaceSandboxes,
} from "../../domain/workspaces/sandbox-registry.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { workspaceGraphFromUnits } from "../../domain/workspaces/workspace-graph.js"
import { writeJobQueueHttpDecision } from "../../domain/workspaces/write-jobs.js"
import {
  githubConnectionIdForWriteProbe,
  writeStatusFromClassification,
} from "../../domain/workspaces/write-status.js"
import {
  createWorkspace,
  deleteWorkspace,
  getMigrationExportSha,
  getWorkspaceBySlug,
  listLinkedRepositories,
  listMigrationExportShas,
  listWorkspaceKnowledgeFiles,
  listWorkspaceKnowledgeUnits,
  listWorkspaces,
  persistHydrateRetry,
  touchLastUsedWorkspace,
  updateWorkspace,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { enqueueWorkspaceTipCheck } from "../../openworkflow/enqueue-workspace-tip-check.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"

async function attachOrgRepository(input: {
  orgId: string
  gitUrl: string
  githubConnectionId?: string | null
  log: { error: (err: Error) => void }
}) {
  try {
    await ensureOrgRepositoryForGitUrl(input)
  } catch (error) {
    input.log.error(error instanceof Error ? error : new Error(String(error)))
  }
}

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("WorkspaceErrorResponse")

const WorkspaceSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    slug: z.string(),
    displayName: z.string(),
    workspaceRepositoryUrl: z.string(),
    githubConnectionId: z.string().nullable(),
    desiredGeneration: z.number().int(),
    desiredSha: z.string().nullable(),
    activeProjectionUrl: z.string().nullable(),
    activeProjectionSha: z.string().nullable(),
    indexedSha: z.string().nullable(),
    writeStatus: z.string(),
    hydrateStatus: z.string(),
    hydrateError: z.string().nullable(),
    migrationExportSha: z.string().nullable(),
    readOnlyReason: z.string().nullable(),
    mostRecentConversationId: z.string().nullable().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Workspace")

const LinkedRepositorySchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    gitUrl: z.string(),
    desiredRef: z.string().nullable(),
    desiredSha: z.string().nullable(),
    indexedSha: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("WorkspaceLinkedRepository")

const WorkspaceDetailSchema = WorkspaceSchema.extend({
  linkedRepositories: z.array(LinkedRepositorySchema),
}).openapi("WorkspaceDetail")

const ListWorkspacesResponseSchema = z
  .object({
    lastUsedWorkspaceId: z.string().nullable(),
    items: z.array(WorkspaceSchema),
  })
  .openapi("WorkspaceListResponse")

const WorkspaceAddSourceSchema = z.enum(["select", "paste"])

const CreateWorkspaceRequestSchema = z
  .object({
    gitUrl: z.string().min(1),
    displayName: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    githubConnectionId: z.string().min(1).optional(),
    source: WorkspaceAddSourceSchema.optional(),
  })
  .openapi("CreateWorkspaceRequest")

const UpdateWorkspaceRequestSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    workspaceRepositoryUrl: z.string().min(1).optional(),
    githubConnectionId: z.string().min(1).nullable().optional(),
    source: WorkspaceAddSourceSchema.optional(),
  })
  .openapi("UpdateWorkspaceRequest")

const DeleteWorkspaceRequestSchema = z
  .object({
    confirmName: z.string().min(1),
  })
  .openapi("DeleteWorkspaceRequest")

const WorkspaceSlugParamsSchema = z
  .object({
    workspaceSlug: z.string().min(1),
  })
  .openapi("WorkspaceSlugParams")

const LinkedRepositoryParamsSchema = z
  .object({
    workspaceSlug: z.string().min(1),
    linkedId: z.string().min(1),
  })
  .openapi("WorkspaceLinkedRepositoryParams")

const CreateLinkedRepositoryRequestSchema = z
  .object({
    gitUrl: z.string().min(1),
  })
  .openapi("CreateWorkspaceLinkedRepositoryRequest")

const LinkedWriteQueuedSchema = z
  .object({
    queued: z.literal(true),
    action: z.enum(["link", "unlink"]),
    gitUrl: z.string(),
  })
  .openapi("WorkspaceLinkedWriteQueued")

function serializeWorkspace(
  row: {
    id: string
    orgId: string
    slug: string
    displayName: string
    workspaceRepositoryUrl: string
    githubConnectionId: string | null
    desiredGeneration: number
    desiredSha: string | null
    activeProjectionUrl: string | null
    activeProjectionSha: string | null
    indexedSha: string | null
    writeStatus: string
    hydrateStatus: string
    hydrateError?: string | null
    readOnlyReason: string | null
    mostRecentConversationId?: string | null
    createdAt: Date
    updatedAt: Date
  },
  migrationExportSha: string | null = null,
) {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    displayName: row.displayName,
    workspaceRepositoryUrl: row.workspaceRepositoryUrl,
    githubConnectionId: row.githubConnectionId,
    desiredGeneration: row.desiredGeneration,
    desiredSha: row.desiredSha,
    activeProjectionUrl: row.activeProjectionUrl,
    activeProjectionSha: row.activeProjectionSha,
    indexedSha: row.indexedSha,
    writeStatus: row.writeStatus,
    hydrateStatus: row.hydrateStatus,
    hydrateError: row.hydrateError ?? null,
    migrationExportSha,
    readOnlyReason: row.readOnlyReason,
    mostRecentConversationId: row.mostRecentConversationId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const listWorkspacesRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": { schema: ListWorkspacesResponseSchema },
      },
      description: "List Workspaces for the current organisation",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateWorkspaceRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: WorkspaceSchema } },
      description: "Created Workspace",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace repository URL already used",
    },
  },
})

const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkspaceDetailSchema } },
      description: "Workspace details",
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

const patchWorkspaceRoute = createRoute({
  method: "patch",
  path: "/{workspaceSlug}",
  request: {
    params: WorkspaceSlugParamsSchema,
    body: {
      content: {
        "application/json": { schema: UpdateWorkspaceRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: WorkspaceSchema } },
      description: "Updated Workspace",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request",
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
      description: "Slug or workspace repository URL conflict",
    },
  },
})

const deleteWorkspaceRoute = createRoute({
  method: "delete",
  path: "/{workspaceSlug}",
  request: {
    params: WorkspaceSlugParamsSchema,
    body: {
      content: {
        "application/json": { schema: DeleteWorkspaceRequestSchema },
      },
    },
  },
  responses: {
    204: { description: "Deleted Workspace" },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "confirmName does not match the display name",
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
      description: "Workspace sandboxes could not be destroyed",
    },
  },
})

const touchWorkspaceRoute = createRoute({
  method: "post",
  path: "/{workspaceSlug}/touch",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    204: { description: "Recorded last-used Workspace" },
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

const retryPrepareWorkspaceRoute = createRoute({
  method: "post",
  path: "/{workspaceSlug}/retry-prepare",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkspaceSchema } },
      description: "Retry Workspace prepare",
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

const listLinkedRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/linked-repositories",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({ items: z.array(LinkedRepositorySchema) })
            .openapi("WorkspaceLinkedRepositoryListResponse"),
        },
      },
      description: "Linked remotes for this Workspace",
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

const createLinkedRoute = createRoute({
  method: "post",
  path: "/{workspaceSlug}/linked-repositories",
  request: {
    params: WorkspaceSlugParamsSchema,
    body: {
      content: {
        "application/json": { schema: CreateLinkedRepositoryRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: { "application/json": { schema: LinkedWriteQueuedSchema } },
      description: "Link write queued",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request",
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
      description: "Already linked",
    },
  },
})

const deleteLinkedRoute = createRoute({
  method: "delete",
  path: "/{workspaceSlug}/linked-repositories/{linkedId}",
  request: { params: LinkedRepositoryParamsSchema },
  responses: {
    202: {
      content: { "application/json": { schema: LinkedWriteQueuedSchema } },
      description: "Unlink write queued",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid request",
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
      description: "Write status unknown",
    },
  },
})

function workspaceSlugParams(c: {
  req: { param: () => Record<string, string> }
}) {
  return WorkspaceSlugParamsSchema.parse(c.req.param())
}

function linkedRepositoryParams(c: {
  req: { param: () => Record<string, string> }
}) {
  return LinkedRepositoryParamsSchema.parse(c.req.param())
}

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

export const workspaceRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listWorkspacesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { items, lastUsedWorkspaceId } = await listWorkspaces()
    const orgId = c.get("orgId")
    if (orgId) void enqueueWorkspaceTipCheck(orgId, c.get("log"))
    const exportShas = await listMigrationExportShas()
    return c.json(
      {
        lastUsedWorkspaceId,
        items: items.map((row) =>
          serializeWorkspace(row, exportShas.get(row.id) ?? null),
        ),
      },
      200,
    )
  })
  .openapi(createWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const body = CreateWorkspaceRequestSchema.parse(await c.req.json())
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Unauthorized" }, 401)
    const githubConnectionId = await resolveWorkspaceGithubConnectionId({
      orgId,
      requested: body.githubConnectionId,
      source: body.source as WorkspaceAddSource | undefined,
    })
    const write = writeStatusFromClassification({
      workspaceRepositoryUrl: body.gitUrl,
      githubConnectionId,
    })
    const created = await createWorkspace({
      gitUrl: body.gitUrl,
      displayName: body.displayName,
      slug: body.slug,
      ...(githubConnectionId ? { githubConnectionId } : {}),
      write,
    })
    await attachOrgRepository({
      orgId: created.orgId,
      gitUrl: created.workspaceRepositoryUrl,
      githubConnectionId: created.githubConnectionId,
      log: c.get("log"),
    })
    void enqueueWorkspaceHydrate(
      { orgId: created.orgId, workspaceId: created.id },
      c.get("log"),
    )
    void enqueueWorkspaceWriteCommit(
      {
        orgId: created.orgId,
        workspaceId: created.id,
        kind: "migration_export",
      },
      c.get("log"),
    )
    for (const gitUrl of created.autoLinkGitUrls) {
      void enqueueWorkspaceWriteCommit(
        {
          orgId: created.orgId,
          workspaceId: created.id,
          kind: "link_unlink",
          linkAction: "link",
          linkGitUrl: gitUrl,
        },
        c.get("log"),
      )
    }
    void enqueueWorkspaceTipCheck(created.orgId, c.get("log"))
    return c.json(serializeWorkspace(created, null), 201)
  })
  .openapi(getWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const linked = await listLinkedRepositories(workspace.id)
    return c.json(
      {
        ...serializeWorkspace(
          workspace,
          await getMigrationExportSha(workspace.id),
        ),
        linkedRepositories: linked.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      200,
    )
  })
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
  .openapi(listWorkspaceGraphRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const { units, lastUpdatedAt } = await listWorkspaceKnowledgeUnits(
      workspace.id,
    )
    return c.json(workspaceGraphFromUnits({ units, lastUpdatedAt }), 200)
  })
  .openapi(patchWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const body = UpdateWorkspaceRequestSchema.parse(await c.req.json())
    const current = await getWorkspaceBySlug(workspaceSlug)
    if (!current) return c.json({ error: "Not found" }, 404)
    const bindingSubmitted =
      body.workspaceRepositoryUrl !== undefined ||
      body.githubConnectionId !== undefined ||
      body.source !== undefined
    const orgId = c.get("orgId") ?? current.orgId
    const githubConnectionId = bindingSubmitted
      ? await resolveWorkspaceGithubConnectionId({
          orgId,
          requested: githubConnectionIdForWriteProbe({
            requested: body.githubConnectionId,
            existing: current.githubConnectionId,
          }),
          source: body.source as WorkspaceAddSource | undefined,
        })
      : current.githubConnectionId
    const write = bindingSubmitted
      ? writeStatusFromClassification({
          workspaceRepositoryUrl:
            body.workspaceRepositoryUrl ?? current.workspaceRepositoryUrl,
          githubConnectionId,
        })
      : undefined
    const persistConnection =
      body.githubConnectionId !== undefined || body.source === "select"
    const updated = await updateWorkspace(workspaceSlug, {
      ...(body.displayName !== undefined
        ? { displayName: body.displayName }
        : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.workspaceRepositoryUrl !== undefined
        ? { workspaceRepositoryUrl: body.workspaceRepositoryUrl }
        : {}),
      ...(persistConnection ? { githubConnectionId } : {}),
      ...(write ? { write } : {}),
    })
    if (!updated) return c.json({ error: "Not found" }, 404)
    if (
      body.workspaceRepositoryUrl &&
      body.workspaceRepositoryUrl !== current.workspaceRepositoryUrl
    ) {
      void destroySandboxesForWorkspace(updated.id)
    }
    if (body.workspaceRepositoryUrl) {
      await attachOrgRepository({
        orgId: updated.orgId,
        gitUrl: updated.workspaceRepositoryUrl,
        githubConnectionId: updated.githubConnectionId,
        log: c.get("log"),
      })
      void enqueueWorkspaceWriteCommit(
        {
          orgId: updated.orgId,
          workspaceId: updated.id,
          kind: "bootstrap",
        },
        c.get("log"),
      )
    }
    if (body.displayName) {
      void enqueueWorkspaceWriteCommit(
        {
          orgId: updated.orgId,
          workspaceId: updated.id,
          kind: "ops_folder_map",
        },
        c.get("log"),
      )
    }
    return c.json(
      serializeWorkspace(updated, await getMigrationExportSha(updated.id)),
      200,
    )
  })
  .openapi(deleteWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const body = DeleteWorkspaceRequestSchema.parse(await c.req.json())
    try {
      const workspace = await getWorkspaceBySlug(workspaceSlug)
      if (!workspace) return c.json({ error: "Not found" }, 404)
      if (body.confirmName !== workspace.displayName) {
        return c.json(
          { error: "Type the Workspace display name to confirm delete" },
          400,
        )
      }
      const deleted = await withDestroyedWorkspaceSandboxes(
        { workspaceId: workspace.id, orgId: workspace.orgId },
        async (remaining) => {
          if (remaining.some((row) => row.providerSandboxId)) {
            throw Object.assign(
              new Error("Workspace sandboxes could not be destroyed"),
              { status: 409 },
            )
          }
          return deleteWorkspace(workspaceSlug, body.confirmName)
        },
      )
      if (!deleted) return c.json({ error: "Not found" }, 404)
      return c.body(null, 204)
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status)
          : undefined
      if (status === 400 || status === 409) {
        const message =
          error instanceof Error ? error.message : "Invalid request"
        return c.json({ error: message }, status)
      }
      throw error
    }
  })
  .openapi(touchWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    await touchLastUsedWorkspace(workspace.id)
    return c.body(null, 204)
  })
  .openapi(retryPrepareWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const retried = await persistHydrateRetry(workspace.id)
    if (!retried) return c.json({ error: "Not found" }, 404)
    const exportSha = await getMigrationExportSha(retried.id)
    void enqueueWorkspaceHydrate(
      { orgId: retried.orgId, workspaceId: retried.id },
      c.get("log"),
    )
    if (shouldHydrateBeforeMigrationExport(exportSha)) {
      void enqueueWorkspaceWriteCommit(
        {
          orgId: retried.orgId,
          workspaceId: retried.id,
          kind: "migration_export",
        },
        c.get("log"),
      )
    }
    return c.json(serializeWorkspace(retried, exportSha), 200)
  })
  .openapi(listLinkedRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const items = await listLinkedRepositories(workspace.id)
    return c.json(
      {
        items: items.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      200,
    )
  })
  .openapi(createLinkedRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const body = CreateLinkedRepositoryRequestSchema.parse(await c.req.json())
    const gitUrl = normalizeWorkspaceRepositoryUrl(body.gitUrl)
    if (!gitUrl) return c.json({ error: "A git URL is required" }, 400)
    if (gitUrl === workspace.workspaceRepositoryUrl) {
      return c.json(
        { error: "The workspace repository is already included for search" },
        409,
      )
    }
    const existing = await listLinkedRepositories(workspace.id)
    if (existing.some((row) => row.gitUrl === gitUrl)) {
      return c.json(
        { error: "That git URL is already linked to this Workspace" },
        409,
      )
    }
    await attachOrgRepository({
      orgId: workspace.orgId,
      gitUrl,
      githubConnectionId: workspace.githubConnectionId,
      log: c.get("log"),
    })
    void enqueueWorkspaceWriteCommit(
      {
        orgId: workspace.orgId,
        workspaceId: workspace.id,
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: body.gitUrl,
      },
      c.get("log"),
    )
    return c.json(
      { queued: true as const, action: "link" as const, gitUrl },
      202,
    )
  })
  .openapi(deleteLinkedRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug, linkedId } = linkedRepositoryParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const existing = await listLinkedRepositories(workspace.id)
    const row = existing.find((item) => item.id === linkedId)
    if (!row) return c.json({ error: "Not found" }, 404)
    void enqueueWorkspaceWriteCommit(
      {
        orgId: workspace.orgId,
        workspaceId: workspace.id,
        kind: "link_unlink",
        linkAction: "unlink",
        linkGitUrl: row.gitUrl,
      },
      c.get("log"),
    )
    return c.json(
      { queued: true as const, action: "unlink" as const, gitUrl: row.gitUrl },
      202,
    )
  })
