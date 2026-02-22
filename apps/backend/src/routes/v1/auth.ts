import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import { sql } from "drizzle-orm"
import type { AppEnv } from "../../app/env.js"
import { getDb } from "../../db/client.js"

const AuthMeResponseSchema = z
  .object({
    user: z.object({
      id: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
    }),
    session: z.object({
      id: z.string(),
      userId: z.string(),
      activeOrganizationId: z.string().nullable(),
    }),
    lastLoginMethod: z.string().nullable(),
  })
  .openapi("AuthMeResponse")

const ErrorSchema = z.object({ error: z.string() }).openapi("AuthMeError")

const authMeRoute = createRoute({
  method: "get",
  path: "/auth/me",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AuthMeResponseSchema,
        },
      },
      description: "Authenticated user context",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Unauthorized",
    },
  },
})

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(authMeRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const db = getDb()
    const result = await db.execute<{ provider_id: string | null }>(
      sql`select provider_id from accounts where user_id = ${user.id} order by updated_at desc limit 1`,
    )
    const latestAccountProvider = result.rows[0]?.provider_id ?? null

    return c.json(
      {
        user: {
          id: user.id,
          email: user.email ?? null,
          name: user.name ?? null,
        },
        session: {
          id: session.id,
          userId: session.userId,
          activeOrganizationId: session.activeOrganizationId ?? null,
        },
        lastLoginMethod: latestAccountProvider ?? "email",
      },
      200,
    )
  })
}
