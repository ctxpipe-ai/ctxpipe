import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  getGithubUserAccessToken,
  getInstallationByOrgId,
  listAllReposForInstallation,
  listReposForInstallation,
  updateInstallationOptions,
  upsertInstallation,
  userCanAccessInstallation,
} from "../../models/github-installation.js"
import {
  createCtxpipeMcpConfigPullRequests,
  type McpOnboardingAgent,
} from "../../models/github-mcp-config-pr.js"
import { listRepositories } from "../../models/repositories.js"
import { ow } from "../../openworkflow/client.js"
import { syncGithubRepositories } from "../../openworkflow/sync-github-repositories.js"

const ErrorResponseSchema = z
  .object({
    // Legacy client error shape
    error: z.string().optional(),
    code: z.string().optional(),
    // evlog structured error shape (varies by transport)
    statusCode: z.number().optional(),
    message: z.string().optional(),
    why: z.string().optional(),
    fix: z.string().optional(),
    link: z.string().url().optional(),
    data: z
      .object({
        why: z.string().optional(),
        fix: z.string().optional(),
        link: z.string().url().optional(),
      })
      .optional(),
  })
  .openapi("ErrorResponse")

const RegisterInstallationBodySchema = z
  .object({
    installationId: z.number(),
  })
  .openapi("RegisterInstallationBody")

const GitHubInstallationSchema = z
  .object({
    id: z.string(),
    installationId: z.number(),
    orgId: z.string(),
    ingestAllRepositories: z.boolean(),
    includeFutureRepos: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("GitHubInstallation")
const GitHubInstallationNullableSchema = z
  .union([GitHubInstallationSchema, z.null()])
  .openapi("GitHubInstallationNullable")

const GitHubRepoItemSchema = z
  .object({
    id: z.number(),
    full_name: z.string(),
    html_url: z.string(),
    clone_url: z.string(),
    name: z.string(),
  })
  .openapi("GitHubRepoItem")

const ListInstallationReposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(30),
})

const ListInstallationReposResponseSchema = z
  .object({
    repositories: z.array(GitHubRepoItemSchema),
    repositorySelection: z.string(),
    hasMore: z.boolean(),
  })
  .openapi("ListInstallationReposResponse")

const SelectedRepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  clone_url: z.string(),
})

const UpdateInstallationOptionsBodySchema = z
  .object({
    ingestAllRepositories: z.boolean(),
    includeFutureRepos: z.boolean(),
    selectedRepositories: z.array(SelectedRepoSchema).optional(),
  })
  .openapi("UpdateInstallationOptionsBody")

const SavedRepoSchema = z.object({
  name: z.string(),
  gitUrl: z.string(),
})

const GitHubInstallationSetupResponseSchema = z
  .object({
    ingestAllRepositories: z.boolean(),
    includeFutureRepos: z.boolean(),
    savedRepositories: z.array(SavedRepoSchema),
  })
  .openapi("GitHubInstallationSetupResponse")

export const getInstallationSetupRoute = createRoute({
  method: "get",
  path: "/setup",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSetupResponseSchema,
        },
      },
      description:
        "Installation settings and previously saved repositories for pre-filling the setup form",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No installation for org",
    },
  },
})

export const getInstallationRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationNullableSchema,
        },
      },
      description:
        "GitHub installation for the org, or null when not installed",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

export const registerInstallationRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: RegisterInstallationBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSchema,
        },
      },
      description: "Installation registered or updated",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "GitHub account not linked",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const listInstallationReposRoute = createRoute({
  method: "get",
  path: "/repositories",
  request: {
    query: ListInstallationReposQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ListInstallationReposResponseSchema,
        },
      },
      description: "List repos accessible to the org's GitHub App installation",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No installation for org",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

const McpOnboardingAgentSchema = z.enum(["cursor", "claude_code", "opencode"])

const CreateMcpConfigPrBodySchema = z
  .object({
    repositories: z.array(z.string().min(1).max(200)).min(1).max(25),
    agents: z.array(McpOnboardingAgentSchema).min(1).max(10),
  })
  .openapi("CreateMcpConfigPrBody")

const CreateMcpConfigPrResponseSchema = z
  .object({
    pullRequests: z.array(
      z.object({
        repository: z.string(),
        pullRequestUrl: z.string().url(),
      }),
    ),
  })
  .openapi("CreateMcpConfigPrResponse")

export const createMcpConfigPrsRoute = createRoute({
  method: "post",
  path: "/mcp-config-prs",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateMcpConfigPrBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CreateMcpConfigPrResponseSchema,
        },
      },
      description:
        "Opened one pull request per repository with MCP config files",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Bad request (e.g. repository not accessible to installation)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No installation for org",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const updateInstallationOptionsRoute = createRoute({
  method: "patch",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: UpdateInstallationOptionsBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSchema,
        },
      },
      description: "Installation options updated",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const githubInstallationReadRoutes = new OpenAPIHono<AppEnv>().openapi(
  getInstallationRoute,
  async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const installation = await getInstallationByOrgId(orgId)
    if (!installation) {
      return c.json(null, 200)
    }
    return c.json(
      {
        ...installation,
        createdAt: installation.createdAt.toISOString(),
        updatedAt: installation.updatedAt.toISOString(),
      },
      200,
    )
  },
)

export const githubInstallationRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getInstallationSetupRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const [installation, repos] = await Promise.all([
      getInstallationByOrgId(orgId),
      listRepositories(),
    ])
    if (!installation) {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    return c.json(
      {
        ingestAllRepositories: installation.ingestAllRepositories,
        includeFutureRepos: installation.includeFutureRepos,
        savedRepositories: repos.map((r) => ({
          name: r.name,
          gitUrl: r.gitUrl,
        })),
      },
      200,
    )
  })
  .openapi(registerInstallationRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const body = c.req.valid("json")
    try {
      const user = c.get("user") as { id: string }
      const githubAccessToken = await getGithubUserAccessToken(user.id)
      if (githubAccessToken) {
        const canAccess = await userCanAccessInstallation(
          githubAccessToken,
          body.installationId,
        )
        if (!canAccess) {
          return c.json({ error: "Forbidden" }, 403)
        }
      }

      const installation = await upsertInstallation(orgId, body.installationId)
      void ow.runWorkflow(syncGithubRepositories.spec, { orgId })
      return c.json(
        {
          ...installation,
          createdAt: installation.createdAt.toISOString(),
          updatedAt: installation.updatedAt.toISOString(),
        },
        200,
      )
    } catch (e) {
      // if it is error from evlog re-throw it
      if (e instanceof Error && e.name === "EvlogError") {
        throw e
      }
      console.error("Error registering installation", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(listInstallationReposRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const installation = await getInstallationByOrgId(orgId)
    if (!installation) {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    const query = ListInstallationReposQuerySchema.parse({
      page: c.req.query("page"),
      per_page: c.req.query("per_page"),
    })
    const env = c.var.env
    try {
      const result = await listReposForInstallation(
        installation.installationId,
        env,
        query.page,
        query.per_page,
      )
      return c.json(result, 200)
    } catch (e) {
      console.error("Error listing installation repos", e)
      return c.json(
        {
          error: e instanceof Error ? e.message : "Failed to list repositories",
        },
        500,
      )
    }
  })
  .openapi(updateInstallationOptionsRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const body = c.req.valid("json")
    try {
      const existingInstallation = await getInstallationByOrgId(orgId)
      if (!existingInstallation) {
        return c.json(
          { error: "No GitHub installation found for this org" },
          404,
        )
      }
      const installation = await updateInstallationOptions(orgId, {
        ingestAllRepositories: body.ingestAllRepositories,
        includeFutureRepos: body.includeFutureRepos,
      })
      if (!installation) {
        return c.json(
          { error: "No GitHub installation found for this org" },
          404,
        )
      }

      const selectedRepos = body.selectedRepositories ?? []
      const workflowPayload =
        !body.ingestAllRepositories && selectedRepos.length > 0
          ? {
              orgId,
              reposToSync: selectedRepos.map((r) => ({
                name: r.full_name,
                gitUrl: r.clone_url,
              })),
            }
          : { orgId }
      void ow.runWorkflow(syncGithubRepositories.spec, workflowPayload)

      return c.json(
        {
          ...installation,
          createdAt: installation.createdAt.toISOString(),
          updatedAt: installation.updatedAt.toISOString(),
        },
        200,
      )
    } catch (e) {
      console.error("Error updating installation options", e)
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(createMcpConfigPrsRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const orgSlug = c.req.param("orgSlug")
    if (!orgSlug) return c.json({ error: "Not found" }, 404)

    const body = CreateMcpConfigPrBodySchema.parse(c.req.valid("json"))
    const installation = await getInstallationByOrgId(orgId)
    if (!installation) {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }

    const env = c.var.env
    let accessible: Awaited<ReturnType<typeof listAllReposForInstallation>>
    try {
      accessible = await listAllReposForInstallation(
        installation.installationId,
        env,
      )
    } catch (e) {
      console.error("Error listing repos for MCP PR", e)
      return c.json(
        {
          error: e instanceof Error ? e.message : "Failed to list repositories",
        },
        500,
      )
    }

    const allowed = new Set(accessible.map((r) => r.full_name))
    const requested: string[] = [...new Set(body.repositories)]
    const notAllowed = requested.filter((name) => !allowed.has(name))
    if (notAllowed.length > 0) {
      return c.json(
        {
          error: `Repositories not accessible to this GitHub installation: ${notAllowed.join(", ")}`,
        },
        400,
      )
    }

    const agents = [...new Set(body.agents)] as McpOnboardingAgent[]

    try {
      const pullRequests = await createCtxpipeMcpConfigPullRequests({
        orgId,
        orgSlug,
        env,
        repositories: requested,
        agents,
      })
      return c.json({ pullRequests }, 200)
    } catch (e) {
      console.error("Error creating MCP config PRs", e)
      return c.json(
        {
          error:
            e instanceof Error ? e.message : "Failed to open pull requests",
        },
        500,
      )
    }
  })
