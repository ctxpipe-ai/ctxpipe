import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import type { AppEnv } from "../../app/env.js"
import { listConversationBaseBranches } from "../../domain/workspaces/conversation-base.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceBySlug,
} from "../../models/workspaces.js"
import { GitRemoteAccessError } from "../../services/git/clone-tree.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
  workspaceSlugParams,
} from "./workspace-route-shared.js"

const WorkspaceBranchesSchema = z
  .object({
    defaultBranch: z.string(),
    branches: z.array(z.string()).openapi({
      description:
        "The branches that a new conversation can start from: the default branch first, then the others by name. The session branches of conversations are not in the list.",
    }),
  })
  .openapi("WorkspaceBranches")

const listBranchesRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/branches",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkspaceBranchesSchema } },
      description: "The base branches for a new conversation (ADR-071)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    502: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "The repository refused the read",
    },
  },
})

export const workspaceBranchesRoutes = new OpenAPIHono<AppEnv>().openapi(
  listBranchesRoute,
  async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const { workspaceSlug } = workspaceSlugParams(c)
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    const revision =
      workspace && (await getDesiredWorkspaceRevision(workspace.id))
    if (!revision) return c.json({ error: "Not found" }, 404)
    try {
      const branches = await listConversationBaseBranches({
        orgId,
        env: c.var.env,
        revision,
      })
      return c.json({ defaultBranch: revision.defaultBranch, branches }, 200)
    } catch (error) {
      if (error instanceof GitRemoteAccessError)
        return c.json({ error: "repository_unavailable" }, 502)
      throw error
    }
  },
)
