import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  getInstallationByOrgId,
  listReposForInstallation,
  updateInstallationOptions,
  upsertInstallation,
} from "../../models/github-installation.js"
import { listRepositories } from "../../models/repositories.js"
import { ow } from "../../openworkflow/client.js"
import { syncGithubRepositories } from "../../openworkflow/sync-github-repositories.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
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
    c.var.log.set({
      route: "githubInstallation.get",
      orgId,
    })
    const installation = await getInstallationByOrgId(orgId)
    if (!installation) {
      c.var.log.warn("github installation lookup returned no result", {
        orgId,
      })
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    c.var.log.set({
      installationId: installation.installationId,
      ingestAllRepositories: installation.ingestAllRepositories,
      includeFutureRepos: installation.includeFutureRepos,
    })
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
    c.var.log.set({
      route: "githubInstallation.setup",
      orgId,
    })
    const [installation, repos] = await Promise.all([
      getInstallationByOrgId(orgId),
      listRepositories(),
    ])
    if (!installation) {
      c.var.log.warn("github installation setup lookup returned no result", {
        orgId,
      })
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    c.var.log.set({
      installationId: installation.installationId,
      savedRepositoryCount: repos.length,
      ingestAllRepositories: installation.ingestAllRepositories,
      includeFutureRepos: installation.includeFutureRepos,
    })
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
    c.var.log.set({
      route: "githubInstallation.register",
      orgId,
      installationId: body.installationId,
    })
    try {
      const installation = await upsertInstallation(orgId, body.installationId)
      c.var.log.info("github installation registered", {
        installationId: installation.installationId,
      })
      return c.json(
        {
          ...installation,
          createdAt: installation.createdAt.toISOString(),
          updatedAt: installation.updatedAt.toISOString(),
        },
        200,
      )
    } catch (error) {
      c.var.log.error(
        error instanceof Error
          ? error
          : "Failed to register GitHub installation",
        {
          orgId,
          installationId: body.installationId,
        },
      )
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(listInstallationReposRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    c.var.log.set({
      route: "githubInstallation.repositories",
      orgId,
    })
    const installation = await getInstallationByOrgId(orgId)
    if (!installation) {
      c.var.log.warn(
        "github installation repository listing had no installation",
        {
          orgId,
        },
      )
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    const query = ListInstallationReposQuerySchema.parse({
      page: c.req.query("page"),
      per_page: c.req.query("per_page"),
    })
    c.var.log.set({
      installationId: installation.installationId,
      page: query.page,
      perPage: query.per_page,
    })
    const env = c.var.env
    try {
      const result = await listReposForInstallation(
        installation.installationId,
        env,
        query.page,
        query.per_page,
      )
      c.var.log.info("github installation repositories loaded", {
        installationId: installation.installationId,
        repositoryCount: result.repositories.length,
        repositorySelection: result.repositorySelection,
        hasMore: result.hasMore,
      })
      return c.json(result, 200)
    } catch (error) {
      c.var.log.error(
        error instanceof Error
          ? error
          : "Failed to list GitHub installation repositories",
        {
          installationId: installation.installationId,
        },
      )
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to list repositories",
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
    c.var.log.set({
      route: "githubInstallation.update",
      orgId,
      ingestAllRepositories: body.ingestAllRepositories,
      includeFutureRepos: body.includeFutureRepos,
      selectedRepositoryCount: body.selectedRepositories?.length ?? 0,
    })
    try {
      const existingInstallation = await getInstallationByOrgId(orgId)
      if (!existingInstallation) {
        c.var.log.warn("github installation update had no installation", {
          orgId,
        })
        return c.json(
          { error: "No GitHub installation found for this org" },
          404,
        )
      }
      c.var.log.set({
        installationId: existingInstallation.installationId,
      })
      const installation = await updateInstallationOptions(orgId, {
        ingestAllRepositories: body.ingestAllRepositories,
        includeFutureRepos: body.includeFutureRepos,
      })
      if (!installation) {
        c.var.log.warn("github installation update returned no installation", {
          orgId,
          installationId: existingInstallation.installationId,
        })
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
      c.var.log.info("github installation options updated and sync queued", {
        installationId: installation.installationId,
        selectedRepositoryCount: selectedRepos.length,
        syncAllRepositories: body.ingestAllRepositories,
      })

      return c.json(
        {
          ...installation,
          createdAt: installation.createdAt.toISOString(),
          updatedAt: installation.updatedAt.toISOString(),
        },
        200,
      )
    } catch (error) {
      c.var.log.error(
        error instanceof Error
          ? error
          : "Failed to update GitHub installation options",
        {
          orgId,
        },
      )
      return c.json({ error: "Internal server error" }, 500)
    }
  })
