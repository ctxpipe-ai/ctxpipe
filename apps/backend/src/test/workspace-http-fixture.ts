import { OpenAPIHono } from "@hono/zod-openapi"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { contextStorage, withTestRequestLogger } from "./hono-test-logger.js"

export function workspaceHttpApp(
  org: { id: string; slug: string; name: string },
  routes: Hono<AppEnv>,
) {
  const env = parseEnv(process.env)
  const id = org.slug
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", contextStorage(), withTestRequestLogger)
  // The seam starts after authentication; models and org/RLS contexts run for real.
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("orgId", org.id)
    c.set("orgSlug", org.slug)
    c.set("user", {
      id: `user_${id}`,
      name: "Contract",
      email: "contract@example.test",
      emailVerified: true,
      twoFactorEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    c.set("session", {
      id: `sess_${id}`,
      userId: `user_${id}`,
      token: id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await withOrgIdContext(org, next)
  })
  app.route("/workspaces", routes)
  return app
}
