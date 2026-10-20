import { createLogger, withLogger } from "../observability/logger.js"

/** Run a helper that calls `getLogger()` without a Hono request. */
export function withTestLogger<T>(fn: () => Promise<T>): Promise<T> {
  return withLogger(createLogger({ test: true }), fn)
}
