import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { directWriteRoute } from "../../auth/write-grant.js"
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
    indexingStatus: z.string().nullable(),
    indexingError: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("WorkspaceLinkedRepository")

const LinkedRepositoryParamsSchema = z
  .object({
    workspaceSlug: z.string().min(1),
    linkedId: z.string().min(1),
  })
  .openapi("WorkspaceLinkedRepositoryParams")

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

const deleteLinkedRoute = createRoute(
  directWriteRoute({
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
  }),
)

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
