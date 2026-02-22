import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  enqueueRepositoryIngestion,
  resolveRepositoryRef,
} from "../../domain/codeIngestion/queue.js"
import { createRepository } from "../../models/repositories.js"

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

export const createRepositoryRoute = createRoute({
  method: "post",
  path: "/repositories",
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

export function registerRepositoryRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(createRepositoryRoute, async (c) => {
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
}
