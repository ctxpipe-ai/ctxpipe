import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { orgIdStorage } from "./withAuth.js"

export function requireCurrentOrgId(): string {
  const orgId = orgIdStorage.getStore()?.id ?? getContext<AppEnv>().var.orgId
  if (!orgId) throw new Error("Missing org context")
  return orgId
}

export function requireCurrentOrgSlug(): string {
  const orgSlug =
    orgIdStorage.getStore()?.slug ?? getContext<AppEnv>().var.orgSlug
  if (!orgSlug) throw new Error("Missing org context")
  return orgSlug
}
