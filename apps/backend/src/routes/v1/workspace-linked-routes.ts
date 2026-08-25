import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { attachOrgRepository } from "../../domain/workspaces/workspace-lifecycle.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  getWorkspaceBySlug,
  listLinkedRepositories,
} from "../../models/workspaces.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
  workspaceSlugParams,
} from "./workspace-route-shared.js"

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

function linkedRepositoryParams(c: {
  req: { param: () => Record<string, string> }
}) {
  return LinkedRepositoryParamsSchema.parse(c.req.param())
}

export const workspaceLinkedRoutes = new OpenAPIHono<AppEnv>()
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

export { LinkedRepositorySchema }
