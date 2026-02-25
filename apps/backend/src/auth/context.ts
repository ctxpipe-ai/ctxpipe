import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"

export function requireCurrentOrgId(): string {
  const orgId = getContext<AppEnv>().var.orgId
  if (!orgId) throw new Error("Missing org context")
  return orgId
}
