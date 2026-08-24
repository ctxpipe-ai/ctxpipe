import { AsyncLocalStorage } from "node:async_hooks"
import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { orgIdStorage } from "./withAuth.js"

const userIdStorage = new AsyncLocalStorage<string>()

export function withUserIdContext<T>(
  userId: string,
  handler: () => Promise<T>,
): Promise<T> {
  return userIdStorage.run(userId, handler)
}

function requestOrg(): { id?: string; slug?: string } {
  try {
    const vars = getContext<AppEnv>().var
    return { id: vars.orgId ?? undefined, slug: vars.orgSlug ?? undefined }
  } catch {
    return {}
  }
}

export function requireCurrentOrgId(): string {
  const orgId = orgIdStorage.getStore()?.id ?? requestOrg().id
  if (!orgId) throw new Error("Missing org context")
  return orgId
}

export function requireCurrentOrgSlug(): string {
  const orgSlug = orgIdStorage.getStore()?.slug ?? requestOrg().slug
  if (!orgSlug) throw new Error("Missing org context")
  return orgSlug
}

export function requireCurrentUserId(): string {
  try {
    const fromRequest = getContext<AppEnv>().var.user?.id
    if (fromRequest) return fromRequest
  } catch {
    /* WebSocket and other non-Hono callers use the ALS below. */
  }
  const fromStore = userIdStorage.getStore()
  if (!fromStore) throw new Error("Missing user context")
  return fromStore
}
