import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { getGithubPrMirrorBinding } from "../../models/github-pr-mirror.js"
import { getRepositoryForOrg } from "../../models/repositories.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { githubEnsurePrMirror } from "../../openworkflow/workflows/github-ensure-pr-mirror.js"
import { githubSyncContent } from "../../openworkflow/workflows/github-sync-content.js"

const ErrorResponseSchema = z.object({ error: z.string() })

const BindingSchema = z.object({
  connectionId: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string(),
  branch: z.string(),
  enabled: z.boolean(),
  setupPhase: z.string(),
  pendingConfigPullUrl: z.string().nullable(),
})

const getRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["GitHub"],
  summary: "Get GitHub pull request mirror binding",
  request: {
    query: z.object({ connectionId: z.string().min(1) }),
  },
  responses: {
    200: {
      description: "Pull request mirror binding, if configured",
      content: {
        "application/json": {
          schema: z.object({ binding: BindingSchema.nullable() }),
        },
      },
    },
    404: {
      description: "GitHub connection not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
})

const bindRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["GitHub"],
  summary: "Bind a context repository and start pull-request capture",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            connectionId: z.string().min(1),
            repositoryId: z.string().min(1),
            branch: z.string().min(1).default("main"),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Pull request capture workflow enqueued",
      content: {
        "application/json": {
          schema: z.object({ accepted: z.literal(true) }),
        },
      },
    },
    400: {
      description: "Invalid binding",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Repository or connection not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
})

const retryContentRoute = createRoute({
  method: "post",
  path: "/sync",
  tags: ["GitHub"],
  summary: "Retry the initial GitHub pull request backfill",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ connectionId: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Content sync enqueued",
      content: {
        "application/json": {
          schema: z.object({ accepted: z.literal(true) }),
        },
      },
    },
    409: {
      description: "Mirror is not ready",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
})

export const githubPrMirrorRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const connectionId = c.req.query("connectionId")
    if (!connectionId) {
      return c.json({ error: "GitHub connection not found" }, 404)
    }
    const binding = await getGithubPrMirrorBinding(orgId, connectionId)
    return c.json(
      {
        binding: binding
          ? {
              connectionId: binding.connectionId,
              repositoryId: binding.repositoryId,
              repositoryName: binding.repositoryName,
              branch: binding.branch,
              enabled: binding.enabled,
              setupPhase: binding.setupPhase,
              pendingConfigPullUrl: binding.pendingConfigPullUrl,
            }
          : null,
      },
      200,
    )
  })
  .openapi(bindRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Context repository not found" }, 404)
    const body = c.req.valid("json")
    const repository = await withOrgDbContext(orgId, () =>
      getRepositoryForOrg(orgId, body.repositoryId),
    )
    if (!repository) {
      return c.json({ error: "Context repository not found" }, 404)
    }
    if (repository.githubConnectionId !== body.connectionId) {
      return c.json(
        {
          error:
            "Context repository must belong to this GitHub App installation",
        },
        400,
      )
    }
    await runWorkflowWithWorkerWake(githubEnsurePrMirror.spec, {
      orgId,
      connectionId: body.connectionId,
      repositoryId: body.repositoryId,
      branch: body.branch,
    })
    return c.json({ accepted: true as const }, 202)
  })
  .openapi(retryContentRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!orgId)
      return c.json({ error: "Pull request mirror is not bound" }, 409)
    const { connectionId } = c.req.valid("json")
    const binding = await getGithubPrMirrorBinding(orgId, connectionId)
    if (!binding) {
      return c.json({ error: "Pull request mirror is not bound" }, 409)
    }
    await runWorkflowWithWorkerWake(githubSyncContent.spec, {
      orgId,
      connectionId,
    })
    return c.json({ accepted: true as const }, 202)
  })
