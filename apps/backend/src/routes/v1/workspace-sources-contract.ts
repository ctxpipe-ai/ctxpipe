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
 * The API contract for Workspace sources (`.ctxpipe/sources.yaml`) and for
 * "Used in" on a connection. The UI gets these types through the `hc` client.
 */

const ProviderSchema = z.enum(SOURCE_PROVIDERS).openapi("SourceProvider")
const StatusSchema = z.enum(SOURCE_STATUSES).openapi("WorkspaceSourceStatus")
const ScopeSchema = z
  .record(z.string(), z.unknown())
  .openapi("WorkspaceSourceScope", {
    description:
      "Provider scope: the entry in .ctxpipe/sources.yaml without id, provider, and connection",
  })

export const WorkspaceSourceSchema = z
  .object({
    /** The file `id`: stable and unique in the file. */
    sourceKey: z.string(),
    provider: ProviderSchema.nullable(),
    connectionId: z.string().nullable(),
    /** The connection's display name, or null when the connection is missing. */
    connectionName: z.string().nullable(),
    scope: ScopeSchema,
    scopeSummary: z.string(),
    status: StatusSchema,
    statusDetail: z.string().nullable(),
    /** The Workspace commit SHA that the row came from. */
    revision: z.string(),
    updatedAt: z.string().datetime(),
  })
  .openapi("WorkspaceSource")

export const PendingSourceChangeSchema = z
  .object({
    sourceKey: z.string(),
    provider: ProviderSchema,
    action: z.enum(["add", "edit", "remove"]),
    pullRequestUrl: z.string().url(),
    createdAt: z.string().datetime(),
  })
  .openapi("PendingWorkspaceSourceChange")

export const WorkspaceSourceListResponseSchema = z
  .object({
    /** The path of the config file in the Workspace repository. */
    path: z.string(),
    /** The Workspace revision of the projection, or null before the first one. */
    revision: z.string().nullable(),
    /** A file-level error (bad YAML, wrong version). Entries are then empty. */
    fileError: z.string().nullable(),
    items: z.array(WorkspaceSourceSchema),
    /** The user can change this Workspace's sources (by PR at least). */
    canEdit: z.boolean(),
    /** Open PRs that change the file ("awaiting merge"). Join on `sourceKey`. */
    pendingChanges: z.array(PendingSourceChangeSchema),
  })
  .openapi("WorkspaceSourceListResponse")

export const WorkspaceSourceInputSchema = z
  .object({
    provider: ProviderSchema,
    connectionId: z.string().min(1),
    scope: ScopeSchema,
  })
  .openapi("WorkspaceSourceInput")

const DeliverySchema = z
  .literal("pull_request")
  .default("pull_request")
  .openapi("WorkspaceSourceDelivery", {
    description:
      "Every source change opens a PR against the default branch (awaiting merge). Config never changes without a PR, so no other value is accepted.",
  })

export const CreateWorkspaceSourceRequestSchema = z
  .object({
    /** Optional. The server makes a key from the provider when absent. */
    sourceKey: z.string().optional(),
    source: WorkspaceSourceInputSchema,
    delivery: DeliverySchema,
  })
  .openapi("CreateWorkspaceSourceRequest")

export const UpdateWorkspaceSourceRequestSchema = z
  .object({
    source: WorkspaceSourceInputSchema,
    delivery: DeliverySchema,
  })
  .openapi("UpdateWorkspaceSourceRequest")

export const DeleteWorkspaceSourceQuerySchema = z
  .object({ delivery: DeliverySchema })
  .openapi("DeleteWorkspaceSourceQuery")

export const WorkspaceSourceChangeResultSchema = z
  .object({
    outcome: z.literal("pull_request"),
    sourceKey: z.string(),
    pullRequestUrl: z.string().url(),
  })
  .openapi("WorkspaceSourceChangeResult")

export const WorkspaceSourceParamsSchema = z
  .object({
    workspaceSlug: z.string().min(1),
    sourceKey: z.string().min(1),
  })
  .openapi("WorkspaceSourceParams")

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
      "Conflict: the key exists (add), the Workspace is read-only, or the file is not valid",
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
      description: "The sources of this Workspace, from .ctxpipe/sources.yaml",
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

export const updateWorkspaceSourceRoute = createRoute({
  method: "put",
  path: "/{workspaceSlug}/sources/{sourceKey}",
  request: {
    params: WorkspaceSourceParamsSchema,
    body: {
      content: {
        "application/json": { schema: UpdateWorkspaceSourceRequestSchema },
      },
    },
  },
  responses: { ...changeOk, ...errors },
})

export const deleteWorkspaceSourceRoute = createRoute({
  method: "delete",
  path: "/{workspaceSlug}/sources/{sourceKey}",
  request: {
    params: WorkspaceSourceParamsSchema,
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
        sourceKey: z.string(),
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
export type ConnectionUsageResponse = z.infer<
  typeof ConnectionUsageResponseSchema
>
