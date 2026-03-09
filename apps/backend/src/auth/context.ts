import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"

export function requireCurrentOrgId(): string {
  const orgId = getContext<AppEnv>().var.orgId
  if (!orgId) throw new Error("Missing org context")
  return orgId
}

export function requireCurrentOrgSlug(): string {
  const orgSlug = getContext<AppEnv>().var.orgSlug
  if (!orgSlug) throw new Error("Missing org context")
  return orgSlug
}
