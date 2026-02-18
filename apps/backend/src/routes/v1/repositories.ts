import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { repositories } from "../../db/schema/index.js"
import { generateObjectId } from "../../lib/id.js"

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
    const db = c.get("db")
    if (!db) {
      return c.json({ error: "Database not configured" }, 503)
    }
    const body = c.req.valid("json")
    const existing = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.gitUrl, body.gitUrl),
          eq(repositories.orgId, body.orgId),
        ),
      )
      .limit(1)
    const row = existing[0]
    if (row) {
      return c.json(
        {
          id: row.id,
          orgId: row.orgId,
          zoektRepoId: row.zoektRepoId,
          name: row.name,
          gitUrl: row.gitUrl,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
        200,
      )
    }
    const id = generateObjectId("repo")
    await db.insert(repositories).values({
      id,
      orgId: body.orgId,
      name: body.name,
      gitUrl: body.gitUrl,
    })
    const [inserted] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, id))
      .limit(1)
    if (!inserted) {
      return c.json({ error: "Failed to read back repository" }, 500)
    }
    return c.json(
      {
        id: inserted.id,
        orgId: inserted.orgId,
        zoektRepoId: inserted.zoektRepoId,
        name: inserted.name,
        gitUrl: inserted.gitUrl,
        createdAt: inserted.createdAt.toISOString(),
        updatedAt: inserted.updatedAt.toISOString(),
      },
      201,
    )
  })
}
