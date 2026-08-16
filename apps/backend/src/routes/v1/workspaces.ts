import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  createWorkspace,
  getWorkspaceBySlug,
  linkRepository,
  listLinkedRepositories,
  listWorkspaces,
  touchLastUsedWorkspace,
  unlinkRepository,
  updateWorkspace,
} from "../../models/workspaces.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"

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

const CreateWorkspaceRequestSchema = z
  .object({
    gitUrl: z.string().min(1),
    displayName: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    githubConnectionId: z.string().min(1).optional(),
  })
  .openapi("CreateWorkspaceRequest")

const UpdateWorkspaceRequestSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    workspaceRepositoryUrl: z.string().min(1).optional(),
    githubConnectionId: z.string().min(1).nullable().optional(),
    readOnlyReason: z.string().min(1).nullable().optional(),
  })
  .openapi("UpdateWorkspaceRequest")

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

function serializeWorkspace(row: {
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
  readOnlyReason: string | null
  mostRecentConversationId?: string | null
  createdAt: Date
  updatedAt: Date
}) {
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
    201: {
      content: { "application/json": { schema: LinkedRepositorySchema } },
      description: "Linked remote",
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
    204: { description: "Unlinked" },
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
    return c.json(
      {
        lastUsedWorkspaceId,
        items: items.map(serializeWorkspace),
      },
      200,
    )
  })
  .openapi(createWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const body = CreateWorkspaceRequestSchema.parse(await c.req.json())
    const created = await createWorkspace(body)
    if (created.writeStatus !== "read_only") {
      void enqueueWorkspaceWriteCommit(
        {
          orgId: created.orgId,
          workspaceId: created.id,
          kind: "migration_export",
        },
        c.get("log"),
      )
    }
    return c.json(serializeWorkspace(created), 201)
  })
  .openapi(getWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const linked = await listLinkedRepositories(workspace.id)
    return c.json(
      {
        ...serializeWorkspace(workspace),
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
    const { workspaceSlug } = c.req.valid("param")
    const body = UpdateWorkspaceRequestSchema.parse(await c.req.json())
    const updated = await updateWorkspace(workspaceSlug, body)
    if (!updated) return c.json({ error: "Not found" }, 404)
    return c.json(serializeWorkspace(updated), 200)
  })
  .openapi(touchWorkspaceRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    await touchLastUsedWorkspace(workspace.id)
    return c.body(null, 204)
  })
  .openapi(listLinkedRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug } = c.req.valid("param")
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
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const body = CreateLinkedRepositoryRequestSchema.parse(await c.req.json())
    const created = await linkRepository({
      workspaceId: workspace.id,
      gitUrl: body.gitUrl,
    })
    return c.json(
      { ...created, createdAt: created.createdAt.toISOString() },
      201,
    )
  })
  .openapi(deleteLinkedRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const { workspaceSlug, linkedId } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const deleted = await unlinkRepository({
      workspaceId: workspace.id,
      linkedId,
    })
    if (!deleted) return c.json({ error: "Not found" }, 404)
    return c.body(null, 204)
  })
