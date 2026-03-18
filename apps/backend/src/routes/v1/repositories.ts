import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  createRepository,
  deleteRepository,
  getRepository,
  listRepositories,
} from "../../models/repositories.js"
import { ow } from "../../openworkflow/client.js"
import { repositoryIngestion } from "../../openworkflow/repository-ingestion.js"

const CreateRepositoryRequestSchema = z
  .object({
    gitUrl: z.string().url(),
    name: z.string().min(1),
  })
  .openapi("CreateRepositoryRequest")
const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse")

const RepositorySchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    zoektRepoId: z.number(),
    name: z.string(),
    gitUrl: z.string(),
    indexReady: z.boolean(),
    lastIngestedHash: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Repository")

const ListRepositoriesResponseSchema = z
  .object({
    items: z.array(RepositorySchema),
  })
  .openapi("ListRepositoriesResponse")

export const listRepositoriesRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ListRepositoriesResponseSchema,
        },
      },
      description: "List repositories for the current org",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
  },
})

const GetRepositoryParamsSchema = z
  .object({ id: z.string() })
  .openapi("GetRepositoryParams")

export const getRepositoryRoute = createRoute({
  method: "get",
  path: "/{id}",
  request: {
    params: GetRepositoryParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RepositorySchema,
        },
      },
      description: "Repository details",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Not found",
    },
  },
})

export const createRepositoryRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateRepositoryRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RepositorySchema,
        },
      },
      description: "Existing repository",
    },
    201: {
      content: {
        "application/json": {
          schema: RepositorySchema,
        },
      },
      description: "Repository created",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "No active organization",
    },
    503: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Database not available",
    },
  },
})

const DeleteRepositoryParamsSchema = z
  .object({ id: z.string() })
  .openapi("DeleteRepositoryParams")

export const deleteRepositoryRoute = createRoute({
  method: "delete",
  path: "/{id}",
  request: {
    params: DeleteRepositoryParamsSchema,
  },
  responses: {
    204: {
      description: "Repository deleted",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
})

export const repositoryRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listRepositoriesRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const repos = await listRepositories()
    const items = repos.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    c.var.log.set({
      route: "repositories.list",
      repositoryCount: items.length,
    })
    return c.json({ items }, 200)
  })
  .openapi(getRepositoryRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    c.var.log.set({
      route: "repositories.get",
      repositoryId: id,
    })
    const repository = await getRepository(id)
    if (!repository) {
      c.var.log.warn("repository lookup returned no result", {
        repositoryId: id,
      })
      return c.json({ error: "Not found" }, 404)
    }
    c.var.log.set({
      repositoryName: repository.name,
      indexReady: repository.indexReady,
    })
    return c.json(
      {
        ...repository,
        createdAt: repository.createdAt.toISOString(),
        updatedAt: repository.updatedAt.toISOString(),
      },
      200,
    )
  })
  .openapi(createRepositoryRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const body = c.req.valid("json")
    c.var.log.set({
      route: "repositories.create",
      repositoryName: body.name,
      gitUrlHost: (() => {
        try {
          return new URL(body.gitUrl).host
        } catch {
          return "invalid"
        }
      })(),
    })
    try {
      const repository = await createRepository({
        name: body.name,
        gitUrl: body.gitUrl,
      })
      void ow.runWorkflow(repositoryIngestion.spec, {
        repositoryId: repository.id,
        orgId: repository.orgId,
      })
      c.var.log.info("repository created and ingestion queued", {
        repositoryId: repository.id,
        repositoryName: repository.name,
        indexReady: repository.indexReady,
      })
      return c.json(
        {
          ...repository,
          createdAt: repository.createdAt.toISOString(),
          updatedAt: repository.updatedAt.toISOString(),
        },
        201,
      )
    } catch (error) {
      c.var.log.error(
        error instanceof Error ? error : "Failed to create repository",
        {
          repositoryName: body.name,
        },
      )
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(deleteRepositoryRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    c.var.log.set({
      route: "repositories.delete",
      repositoryId: id,
    })
    try {
      const repository = await deleteRepository(id)
      if (!repository) {
        c.var.log.warn("repository delete target was not found", {
          repositoryId: id,
        })
        return c.json({ error: "Not found" }, 404)
      }
      c.var.log.info("repository deleted", {
        repositoryId: id,
      })
      return c.body(null, 204)
    } catch (error) {
      c.var.log.error(
        error instanceof Error ? error : "Failed to delete repository",
        {
          repositoryId: id,
        },
      )
      return c.json({ error: "Internal server error" }, 500)
    }
  })
