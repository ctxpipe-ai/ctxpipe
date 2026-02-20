import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { createRepository } from "../../models/repositories.js"

const CreateRepositoryRequestSchema = z
  .object({
    gitUrl: z.string().url(),
    orgId: z.string().min(1),
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
    const body = c.req.valid("json")
    try {
      const repository = await createRepository({
        name: body.name,
        gitUrl: body.gitUrl,
      })
      return c.json(
        {
          ...repository,
          createdAt: repository.createdAt.toISOString(),
          updatedAt: repository.updatedAt.toISOString(),
        },
        201,
      )
    } catch (e) {
      return c.json({ error: "Internal server error" }, 500)
    }
  })
}
