import { AsyncLocalStorage } from "node:async_hooks"
import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"

const systemOrgIdStorage = new AsyncLocalStorage<string>()

/**
 * Run a background (non-Hono) function with an org ID in scope.
 * This lets model functions that call requireCurrentOrgId() work outside
 * of a request context, e.g. in scheduled sync workers.
 */
export function withSystemOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return systemOrgIdStorage.run(orgId, fn)
}

export function requireCurrentOrgId(): string {
  const systemOrgId = systemOrgIdStorage.getStore()
  if (systemOrgId) return systemOrgId

  const orgId = getContext<AppEnv>().var.orgId
  if (!orgId) throw new Error("Missing org context")
  return orgId
}
