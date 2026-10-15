import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { SourceChangeError } from "../../domain/workspace-sources/edit.js"
import { unlinkWorkspaceRepository } from "../../domain/workspace-sources/service.js"
import {
  getWorkspaceBySlug,
  listLinkedRepositories,
} from "../../models/workspaces.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
  workspaceSlugParams,
} from "./workspace-route-shared.js"
import { WorkspaceSourceChangeResultSchema } from "./workspace-sources-contract.js"

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

const deleteLinkedRoute = createRoute({
  method: "delete",
  path: "/{workspaceSlug}/linked-repositories/{linkedId}",
  request: { params: LinkedRepositoryParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: WorkspaceSourceChangeResultSchema },
      },
      description: "The pull request that unlinks the repository",
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
      description:
        "The Workspace is read-only, or no file of the default branch links the repository",
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
    // An unlink changes the sources config, so it goes by a pull request.
    try {
      return c.json(
        await unlinkWorkspaceRepository({ workspace, gitUrl: row.gitUrl }),
        200,
      )
    } catch (error) {
      if (error instanceof SourceChangeError)
        return c.json({ error: error.message }, error.status)
      throw error
    }
  })

export { LinkedRepositorySchema }
