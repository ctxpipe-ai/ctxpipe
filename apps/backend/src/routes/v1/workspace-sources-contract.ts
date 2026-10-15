import { createRoute, z } from "@hono/zod-openapi"
import {
  SOURCE_PROVIDERS,
  SOURCE_STATUSES,
} from "../../domain/workspace-sources/sources-file.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
} from "./workspace-route-shared.js"

/**
 * The API contract for Workspace sources (one Markdown file under `sources/`
 * for each source, ADR-050) and for "Used in" on a connection. A source is
 * named by its path, relative to the Workspace root folder. The UI gets these types through the `hc` client.
 */

const ProviderSchema = z.enum(SOURCE_PROVIDERS).openapi("SourceProvider")
const StatusSchema = z.enum(SOURCE_STATUSES).openapi("WorkspaceSourceStatus")
const ScopeSchema = z
  .record(z.string(), z.unknown())
  .openapi("WorkspaceSourceScope", {
    description:
      "Provider scope: the front matter of the source file without provider and connection",
  })

export const WorkspaceSourceSchema = z
  .object({
    /** The path of the source file, for example sources/github/acme/web.md. */
    path: z.string(),
    provider: ProviderSchema.nullable(),
    connectionId: z.string().nullable(),
    /** The connection's display name, or null when the connection is missing. */
    connectionName: z.string().nullable(),
    scope: ScopeSchema,
    scopeSummary: z.string(),
    status: StatusSchema,
    statusDetail: z.string().nullable(),
    /**
     * The body of the source file (what the source is for), read from git at
     * `revision`. Absent when the file has no body, is over 64 KiB, or git
     * cannot be read.
     */
    description: z.string().optional(),
    /** False when the row has no source file, so a remove cannot name it. */
    removable: z.boolean(),
    /** The Workspace commit SHA that the row came from. */
    revision: z.string(),
    updatedAt: z.string().datetime(),
  })
  .openapi("WorkspaceSource")

export const PendingSourceChangeSchema = z
  .object({
    /** The path that the pull request changes (the old path for a rename). */
    path: z.string(),
    provider: ProviderSchema,
    action: z.enum(["add", "edit", "rename", "remove"]),
    pullRequestUrl: z.string().url(),
    createdAt: z.string().datetime(),
  })
  .openapi("PendingWorkspaceSourceChange")

export const LinkErrorSchema = z
  .object({
    action: z.enum(["link", "unlink"]),
    gitUrl: z.string(),
    /** Why the edit cannot be made. */
    reason: z.string(),
    failedAt: z.string().datetime(),
  })
  .openapi("WorkspaceSourceLinkError")

export const WorkspaceSourceListResponseSchema = z
  .object({
    /** The folder of the source files in the Workspace repository. */
    path: z.string(),
    /** The Workspace revision of the projection, or null before the first one. */
    revision: z.string().nullable(),
    /** A file-level error of the legacy .ctxpipe/sources.yaml file, or null. */
    fileError: z.string().nullable(),
    items: z.array(WorkspaceSourceSchema),
    /** The user can change this Workspace's sources (by PR at least). */
    canEdit: z.boolean(),
    /** The Workspace accepts a direct commit of the change (delivery `commit`). */
    directCommitAllowed: z.boolean(),
    /** Open PRs that change a source file ("awaiting merge"). Join on `path`. */
    pendingChanges: z.array(PendingSourceChangeSchema),
    /** Repository link edits that cannot be made, newest first. */
    linkErrors: z.array(LinkErrorSchema),
  })
  .openapi("WorkspaceSourceListResponse")

export const WorkspaceSourceInputSchema = z
  .object({
    provider: ProviderSchema,
    connectionId: z.string().min(1),
    scope: ScopeSchema,
    /**
     * The body of the source file: what the source is for. An edit without it
     * keeps the body. Send an empty string to clear it.
     */
    description: z.string().max(4000).optional(),
  })
  .openapi("WorkspaceSourceInput")

const DeliverySchema = z
  .enum(["pull_request", "commit"])
  .default("pull_request")
  .openapi("WorkspaceSourceDelivery", {
    description:
      "pull_request opens a PR against the default branch (awaiting merge). commit queues a direct commit to the default branch through the Workspace write queue.",
  })

export const CreateWorkspaceSourceRequestSchema = z
  .object({
    /**
     * Optional. The server names the file when absent:
     * sources/github/<owner>/<name>.md for GitHub, else sources/<provider>/<provider>.md.
     */
    path: z.string().optional(),
    source: WorkspaceSourceInputSchema,
    delivery: DeliverySchema,
  })
  .openapi("CreateWorkspaceSourceRequest")

export const BatchCreateWorkspaceSourcesRequestSchema = z
  .object({
    /** The new sources. One refused source refuses the whole request. */
    sources: z
      .array(
        z.object({
          /** Optional. Named as in `CreateWorkspaceSourceRequest.path`. */
          path: z.string().optional(),
          source: WorkspaceSourceInputSchema,
        }),
      )
      .min(1)
      .max(20),
    delivery: DeliverySchema,
  })
  .openapi("BatchCreateWorkspaceSourcesRequest", {
    description:
      "Add several sources in one pull request or one direct commit.",
  })

export const UpdateWorkspaceSourceRequestSchema = z
  .object({
    /** The path of the source file to change. */
    path: z.string().min(1),
    source: WorkspaceSourceInputSchema,
    delivery: DeliverySchema,
  })
  .openapi("UpdateWorkspaceSourceRequest")

export const RenameWorkspaceSourceRequestSchema = z
  .object({
    path: z.string().min(1),
    /** The new path. The provider folder stays the same. */
    newPath: z.string().min(1),
    delivery: DeliverySchema,
  })
  .openapi("RenameWorkspaceSourceRequest", {
    description:
      "Move a source file in one commit. The hydrate of the new revision gives the new path to each unit that names the old path in its sources list.",
  })

export const DeleteWorkspaceSourceQuerySchema = z
  .object({ path: z.string().min(1), delivery: DeliverySchema })
  .openapi("DeleteWorkspaceSourceQuery")

export const WorkspaceSourceChangeResultSchema = z
  .discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("pull_request"),
      /** The path of the changed file (the new path for a rename). */
      path: z.string(),
      pullRequestUrl: z.string().url(),
    }),
    z.object({
      // The durable Workspace write queue commits to the default branch.
      outcome: z.literal("commit_queued"),
      path: z.string(),
    }),
  ])
  .openapi("WorkspaceSourceChangeResult")

export const WorkspaceSourceBatchResultSchema = z
  .discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("pull_request"),
      /** The path of each added file, in request order. */
      paths: z.array(z.string()),
      pullRequestUrl: z.string().url(),
    }),
    z.object({
      outcome: z.literal("commit_queued"),
      paths: z.array(z.string()),
    }),
  ])
  .openapi("WorkspaceSourceBatchResult")

const errors = {
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
    description:
      "Conflict: the path exists (add or rename), the Workspace is read-only, or the file is not valid",
  },
} as const

const changeOk = {
  200: {
    content: {
      "application/json": { schema: WorkspaceSourceChangeResultSchema },
    },
    description: "The file change: a PR (awaiting merge) or a queued commit",
  },
} as const

export const listWorkspaceSourcesRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/sources",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceSourceListResponseSchema },
      },
      description:
        "The sources of this Workspace, from the files under sources/",
    },
    401: errors[401],
    404: errors[404],
  },
})

export const createWorkspaceSourceRoute = createRoute({
  method: "post",
  path: "/{workspaceSlug}/sources",
  request: {
    params: WorkspaceSlugParamsSchema,
    body: {
      content: {
        "application/json": { schema: CreateWorkspaceSourceRequestSchema },
      },
    },
  },
  responses: { ...changeOk, ...errors },
})

export const batchCreateWorkspaceSourcesRoute = createRoute({
  method: "post",
  path: "/{workspaceSlug}/sources/batch",
  request: {
    params: WorkspaceSlugParamsSchema,
    body: {
      content: {
        "application/json": {
          schema: BatchCreateWorkspaceSourcesRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceSourceBatchResultSchema },
      },
      description:
        "The file change: one PR (awaiting merge) or one queued commit",
    },
    ...errors,
  },
})

export const updateWorkspaceSourceRoute = createRoute({
  method: "put",
  path: "/{workspaceSlug}/sources",
  request: {
    params: WorkspaceSlugParamsSchema,
    body: {
      content: {
        "application/json": { schema: UpdateWorkspaceSourceRequestSchema },
      },
    },
  },
  responses: { ...changeOk, ...errors },
})

export const renameWorkspaceSourceRoute = createRoute({
  method: "post",
  path: "/{workspaceSlug}/sources/rename",
  request: {
    params: WorkspaceSlugParamsSchema,
    body: {
      content: {
        "application/json": { schema: RenameWorkspaceSourceRequestSchema },
      },
    },
  },
  responses: { ...changeOk, ...errors },
})

export const deleteWorkspaceSourceRoute = createRoute({
  method: "delete",
  path: "/{workspaceSlug}/sources",
  request: {
    params: WorkspaceSlugParamsSchema,
    query: DeleteWorkspaceSourceQuerySchema,
  },
  responses: { ...changeOk, ...errors },
})

export const ConnectionUsageItemSchema = z
  .object({
    workspaceId: z.string(),
    workspaceSlug: z.string(),
    workspaceName: z.string(),
    /** The base stat, for example "5 linked repositories" or "3 spaces". */
    stat: z.string(),
    sources: z.array(
      z.object({
        path: z.string(),
        provider: ProviderSchema,
        status: StatusSchema,
        scopeSummary: z.string(),
      }),
    ),
    /** Open source pull requests of this provider that wait for a merge. */
    pendingChanges: z.array(PendingSourceChangeSchema),
  })
  .openapi("ConnectionUsageItem")

export const ConnectionUsageResponseSchema = z
  .object({ items: z.array(ConnectionUsageItemSchema) })
  .openapi("ConnectionUsageResponse")

export const ConnectionIdParamsSchema = z
  .object({ connectionId: z.string().min(1) })
  .openapi("ConnectionIdParams")

export const listConnectionWorkspacesRoute = createRoute({
  method: "get",
  path: "/{connectionId}/workspaces",
  request: { params: ConnectionIdParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConnectionUsageResponseSchema },
      },
      description: "The Workspaces whose sources use this connection",
    },
    401: errors[401],
    404: errors[404],
  },
})

export const syncConnectionSourcesRoute = createRoute({
  method: "post",
  path: "/{connectionId}/sync",
  request: { params: ConnectionIdParamsSchema },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({ accepted: z.literal(true) }),
        },
      },
      description:
        "A full sync of the connection's Workspace sources is queued. A second request in the same minute queues no other sync.",
    },
    401: errors[401],
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden: only an org admin or owner can start a sync",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No Workspace source of this connection can sync",
    },
  },
})

export type WorkspaceSourceListResponse = z.infer<
  typeof WorkspaceSourceListResponseSchema
>
export type WorkspaceSourceChangeResult = z.infer<
  typeof WorkspaceSourceChangeResultSchema
>
export type WorkspaceSourceBatchResult = z.infer<
  typeof WorkspaceSourceBatchResultSchema
>
export type ConnectionUsageResponse = z.infer<
  typeof ConnectionUsageResponseSchema
>
