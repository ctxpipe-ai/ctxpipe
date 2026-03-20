import { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { listRepositories } from "../../models/repositories.js"
import {
  getInstallationByOrgId,
  getGithubUserAccessToken,
  listReposForInstallation,
  updateInstallationOptions,
  upsertInstallation,
  userCanAccessInstallation,
} from "../../models/github-installation.js"
import { syncGithubRepositories } from "../../openworkflow/sync-github-repositories.js"
import { ow } from "../../openworkflow/client.js"

const ErrorResponseSchema = z
  .object({ error: z.string(), code: z.string().optional() })
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
          schema: GitHubInstallationSchema,
        },
      },
      description: "GitHub installation for the org",
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

export const githubInstallationRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getInstallationRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const installation = await getInstallationByOrgId(orgId)
    if (!installation) {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    return c.json(
      {
        ...installation,
        createdAt: installation.createdAt.toISOString(),
        updatedAt: installation.updatedAt.toISOString(),
      },
      200,
    )
  })
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
      if (!githubAccessToken) {
        return c.json(
          { error: "GitHub account not linked", code: "github_not_linked" },
          409,
        )
      }

      const canAccess = await userCanAccessInstallation(
        githubAccessToken,
        body.installationId,
      )
      if (!canAccess) {
        return c.json({ error: "Forbidden" }, 403)
      }

      const installation = await upsertInstallation(orgId, body.installationId)
      return c.json(
        {
          ...installation,
          createdAt: installation.createdAt.toISOString(),
          updatedAt: installation.updatedAt.toISOString(),
        },
        200,
      )
    } catch (e) {
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
          error:
            e instanceof Error ? e.message : "Failed to list repositories",
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
        return c.json({ error: "No GitHub installation found for this org" }, 404)
      }
      const installation = await updateInstallationOptions(orgId, {
        ingestAllRepositories: body.ingestAllRepositories,
        includeFutureRepos: body.includeFutureRepos,
      })
      if (!installation) {
        return c.json({ error: "No GitHub installation found for this org" }, 404)
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
