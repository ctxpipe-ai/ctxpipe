import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { orgIdStorage } from "./withAuth.js"

function requestOrg(): { id?: string; slug?: string } {
  try {
    const vars = getContext<AppEnv>().var
    return { id: vars.orgId, slug: vars.orgSlug }
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
  const userId = getContext<AppEnv>().var.user?.id
  if (!userId) throw new Error("Missing user context")
  return userId
}
