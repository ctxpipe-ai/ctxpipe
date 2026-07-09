import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  createRepository,
  deleteRepository,
  getRepository,
  listRepositories,
  type RepositoryWithSearch,
} from "../../models/repositories.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"

const CreateRepositoryRequestSchema = z
  .object({
    gitUrl: z.string().url(),
    name: z.string().min(1),
  })
  .openapi("CreateRepositoryRequest")
const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse")
const RepositoryIndexingStatusSchema = z.enum([
  "queued",
  "running",
  "ready",
  "failed",
])
type RepositoryIndexingStatus = z.infer<typeof RepositoryIndexingStatusSchema>

const RepositorySchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    zoektRepoId: z.number(),
    name: z.string(),
    gitUrl: z.string(),
    indexReady: z.boolean(),
    indexingStatus: RepositoryIndexingStatusSchema,
    indexingError: z.string().nullable(),
    indexingFailedAt: z.string().datetime().nullable(),
    indexingReason: z.string().nullable(),
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
const ReindexRepositoryParamsSchema = z
  .object({ id: z.string() })
  .openapi("ReindexRepositoryParams")

export const deleteRepositoryRoute = createRoute({
  method: "delete",
  path: "/{id}",
  request: {
    params: DeleteRepositoryParamsSchema,
  },
  responses: {
    202: {
      description: "Repository delete accepted",
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

export const reindexRepositoryRoute = createRoute({
  method: "post",
  path: "/{id}/reindex",
  request: {
    params: ReindexRepositoryParamsSchema,
  },
  responses: {
    202: {
      description: "Repository reindex accepted",
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

function serializeRepository(repository: RepositoryWithSearch) {
  const indexingStatus: RepositoryIndexingStatus =
    repository.indexingStatus === "queued" ||
    repository.indexingStatus === "running" ||
    repository.indexingStatus === "ready" ||
    repository.indexingStatus === "failed"
      ? repository.indexingStatus
      : repository.indexReady
        ? "ready"
        : "running"

  return {
    ...repository,
    indexingStatus,
    indexingError: repository.indexingError ?? null,
    indexingFailedAt: repository.indexingFailedAt?.toISOString() ?? null,
    indexingReason: repository.indexingReason ?? null,
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
  }
}

export const repositoryRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listRepositoriesRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const repos = await listRepositories()
    const items = repos.map((r) => serializeRepository(r))
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
    return c.json(serializeRepository(repository), 200)
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
      void enqueueRepositoryIngestionWorkflow(
        { repositoryId: repository.id, orgId: repository.orgId },
        {
          error: (err) =>
            c.get("log").error(err, { step: "repositories.create.enqueue-ingestion" }),
        },
      )
      return c.json(
        serializeRepository(repository),
        201,
      )
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "repositories.create",
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(reindexRepositoryRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const id = c.req.param("id")
    try {
      const repository = await getRepository(id)
      if (!repository) {
        return c.json({ error: "Not found" }, 404)
      }
      await enqueueRepositoryIngestionWorkflow(
        {
          repositoryId: repository.id,
          orgId: repository.orgId,
          indexingReason: "manual",
        },
        {
          error: (err) =>
            c
              .get("log")
              .error(err, { step: "repositories.reindex.enqueue", repositoryId: id }),
        },
      )
      return c.body(null, 202)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "repositories.reindex",
        repositoryId: id,
      })
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
      const repository = await getRepository(id)
      if (!repository) {
        return c.json({ error: "Not found" }, 404)
      }
      void deleteRepository(id).catch((e) => {
        c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
          step: "repositories.delete.background",
          repositoryId: id,
        })
      })
      return c.body(null, 202)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "repositories.delete",
        repositoryId: id,
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
