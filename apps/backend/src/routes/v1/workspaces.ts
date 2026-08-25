import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { shouldHydrateBeforeMigrationExport } from "../../domain/workspaces/hydrate.js"
import { WORKSPACE_WRITE_STATUSES } from "../../domain/workspaces/write-status.js"
import { withDestroyedWorkspaceSandboxes } from "../../domain/workspaces/sandbox-registry.js"
import {
  createWorkspaceLifecycle,
  relinkWorkspaceLifecycle,
  renameWorkspaceLifecycle,
} from "../../domain/workspaces/workspace-lifecycle.js"
import {
  deleteWorkspace,
  getMigrationExportSha,
  getWorkspaceBySlug,
  listLinkedRepositories,
  listMigrationExportShas,
  listWorkspaces,
  persistHydrateRetry,
  touchLastUsedWorkspace,
} from "../../models/workspaces.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { enqueueWorkspaceTipCheck } from "../../openworkflow/enqueue-workspace-tip-check.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { workspaceFilesRoutes } from "./workspace-files-routes.js"
import { workspaceGraphRoutes } from "./workspace-graph-routes.js"
import {
  LinkedRepositorySchema,
  workspaceLinkedRoutes,
} from "./workspace-linked-routes.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
  workspaceSlugParams,
} from "./workspace-route-shared.js"

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

export const workspaceRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listWorkspacesRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { items, lastUsedWorkspaceId } = await listWorkspaces()
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
    const created = await createWorkspaceLifecycle({
      orgId,
      gitUrl: body.gitUrl,
      displayName: body.displayName,
      slug: body.slug,
      githubConnectionId: body.githubConnectionId,
      source: body.source,
      log: c.get("log"),
    })
    return c.json(serializeWorkspace(created, null), 201)
  })
  .openapi(getWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const orgId = c.get("orgId")
    if (orgId && workspace.writeStatus === WORKSPACE_WRITE_STATUSES.read_only) {
      void enqueueWorkspaceTipCheck(orgId, c.get("log"))
    }
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
    const persistConnection =
      body.githubConnectionId !== undefined || body.source === "select"
    const { workspace: updated } = await relinkWorkspaceLifecycle({
      slug: workspaceSlug,
      current,
      orgId: c.get("orgId") ?? current.orgId,
      workspaceRepositoryUrl: body.workspaceRepositoryUrl,
      githubConnectionId: body.githubConnectionId,
      source: body.source,
      nextSlug: body.slug,
      persistConnection,
      bindingSubmitted,
      log: c.get("log"),
    })
    if (!updated) return c.json({ error: "Not found" }, 404)
    if (body.displayName) {
      await renameWorkspaceLifecycle({
        orgId: updated.orgId,
        workspaceId: updated.id,
        log: c.get("log"),
      })
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
  .route("/", workspaceFilesRoutes)
  .route("/", workspaceGraphRoutes)
  .route("/", workspaceLinkedRoutes)
