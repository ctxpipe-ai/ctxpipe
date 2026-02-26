import { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  enqueueRepositoryIngestion,
  resolveRepositoryRef,
} from "../../domain/codeIngestion/queue.js"
import {
  createRepository,
  deleteRepository,
  getRepository,
  listRepositories,
} from "../../models/repositories.js"

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
    return c.json({ items }, 200)
  })
  .openapi(getRepositoryRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    const repository = await getRepository(id)
    if (!repository) {
      return c.json({ error: "Not found" }, 404)
    }
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
    try {
      const repository = await createRepository({
        name: body.name,
        gitUrl: body.gitUrl,
      })
      const resolved = await resolveRepositoryRef({
        repositoryId: repository.id,
        orgId: repository.orgId,
      })
      await enqueueRepositoryIngestion({
        repositoryId: repository.id,
        orgId: repository.orgId,
        targetHash: resolved.hash,
        sourceBranch: resolved.branch,
        fromHash: repository.lastIngestedHash,
      })
      return c.json(
        {
          ...repository,
          createdAt: repository.createdAt.toISOString(),
          updatedAt: repository.updatedAt.toISOString(),
        },
        201,
      )
    } catch {
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
    try {
      const repository = await deleteRepository(id)
      if (!repository) {
        return c.json({ error: "Not found" }, 404)
      }
      return c.body(null, 204)
    } catch {
      return c.json({ error: "Internal server error" }, 500)
    }
  })
