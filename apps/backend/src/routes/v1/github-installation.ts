import { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  bulkCreateRepositories,
} from "../../models/repositories.js"
import {
  getInstallationByOrgId,
  listAllReposForInstallation,
  listReposForInstallation,
  updateInstallationOptions,
  upsertInstallation,
} from "../../models/github-installation.js"
import { repositoryIngestion } from "../../openworkflow/repository-ingestion.js"
import { ow } from "../../openworkflow/client.js"

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
  .openapi(registerInstallationRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const body = c.req.valid("json")
    try {
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

      let toInsert: Array<{ name: string; gitUrl: string }>
      if (body.ingestAllRepositories) {
        const allRepos = await listAllReposForInstallation(
          existingInstallation.installationId,
          c.var.env,
        )
        toInsert = allRepos.map((r) => ({
          name: r.full_name,
          gitUrl: r.clone_url,
        }))
      } else {
        const selected = body.selectedRepositories ?? []
        toInsert = selected.map((r) => ({
          name: r.full_name,
          gitUrl: r.clone_url,
        }))
      }

      const created = await bulkCreateRepositories(toInsert)
      for (const repo of created) {
        void ow.runWorkflow(repositoryIngestion.spec, {
          repositoryId: repo.id,
          orgId: repo.orgId,
        })
      }
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
