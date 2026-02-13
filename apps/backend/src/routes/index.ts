import type { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { registerHealthRoutes } from "./health.js"

export function registerRoutes(app: OpenAPIHono<AppEnv>) {
  registerHealthRoutes(app)
  // Add more route modules here, e.g. registerAuthRoutes(app)
}
