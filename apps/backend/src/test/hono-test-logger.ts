import type { MiddlewareHandler } from "hono"
import { contextStorage } from "hono/context-storage"

import type { AppEnv } from "../app/env.js"
import { createLogger } from "../observability/logger.js"

/**
 * A logger for `c.set("log", …)` in a route test. evlog types `c.var.log` as
 * the request logger of its middleware, which also has `fork`. Route code does
 * not call `fork`, so a plain logger is sufficient.
 */
export function createTestLogger(
  context?: Record<string, unknown>,
): AppEnv["Variables"]["log"] {
  return createLogger(context) as AppEnv["Variables"]["log"]
}

/** ALS + Hono `c.var.log` so `getLogger()` works in route tests without mocking evlog. */
export const withTestRequestLogger: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  // A test that mounts the real evlog middleware keeps its logger.
  if (!c.get("log")) c.set("log", createTestLogger({ test: true }))
  await next()
}

export { contextStorage }
