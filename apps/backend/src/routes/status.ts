import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"

export function registerStatusRoutes(app: Hono<AppEnv>) {
  app.get("/.status", () =>
    Response.json({ status: "ok", timestamp: new Date().toISOString() }),
  )
  return app
}
