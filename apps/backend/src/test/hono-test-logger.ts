import type { MiddlewareHandler } from "hono"
import { contextStorage } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { createLogger } from "../observability/logger.js"

/** ALS + Hono `c.var.log` so `getLogger()` works in route tests without mocking evlog. */
export const withTestRequestLogger: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  c.set("log", createLogger({ test: true }) as AppEnv["Variables"]["log"])
  await next()
}

export { contextStorage }
