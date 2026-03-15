import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import type { AppEnv } from "../app/env.js"
import { ZOEKT_WEBSERVER_URL } from "../config/paths.js"
import { repositories } from "../db/schema.js"

const SearchRequestSchema = z
  .object({
    Q: z.string().openapi({ example: "needle" }),
    RepoIDs: z.array(z.number()).optional(),
    Opts: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SearchRequest")

const SearchResponseSchema = z.record(z.string(), z.unknown())

export const searchRoute = createRoute({
  method: "post",
  path: "/search",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SearchRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SearchResponseSchema,
        },
      },
      description: "Zoekt search result",
    },
    503: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Database or Zoekt not available",
    },
  },
})

export function registerSearchRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(searchRoute, async (c) => {
    const db = c.get("db")
    if (!db) {
      return c.json({ error: "Database not configured" }, 503)
    }
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const body = c.req.valid("json")
    const rows = await db
      .select({ zoektRepoId: repositories.zoektRepoId })
      .from(repositories)
      .where(eq(repositories.orgId, auth.orgId))
    const orgRepoIds = rows.map((r) => r.zoektRepoId)
    const repoIds =
      body.RepoIDs?.length && body.RepoIDs.length > 0
        ? body.RepoIDs
        : orgRepoIds.length > 0
          ? orgRepoIds
          : body.RepoIDs ?? []
    const payload = {
      Q: body.Q,
      RepoIDs: repoIds,
      Opts: body.Opts,
    }
    try {
      const res = await fetch(`${ZOEKT_WEBSERVER_URL}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        return c.json({ error: `Zoekt returned status ${res.status}` }, 503)
      }
      const data = await res.json().catch(() => ({}))
      return c.json(data, 200)
    } catch {
      return c.json({ error: "Zoekt webserver is unavailable" }, 503)
    }
  })
}
