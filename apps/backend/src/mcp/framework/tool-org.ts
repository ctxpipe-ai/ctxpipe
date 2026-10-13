import { getContext } from "hono/context-storage"
import type { AppEnv } from "../../app/env.js"
import {
  type CallOrg,
  callPrincipalFromContext,
  listCallOrgs,
  resolveCallOrg,
} from "../../auth/call-org.js"
import { orgNotFound, orgRequired } from "./tool-errors.js"

export type { CallOrg }

function principal() {
  return callPrincipalFromContext(getContext<AppEnv>())
}

/** The orgs that the principal of this request can name in a tool call. */
export function listToolOrgs(): Promise<CallOrg[]> {
  return listCallOrgs(principal())
}

/**
 * The org that the `org` argument of one tool call names (ADR-051 §3). The
 * principal's allowed orgs ∩ live membership decide; `?orgSlug=` on the URL
 * has no effect. An unknown org and an org outside the connection give the
 * same `org_not_found` error.
 */
export async function requireToolOrg(slug: string): Promise<CallOrg> {
  const wanted = slug.trim().toLowerCase()
  if (!wanted) throw orgRequired()
  const result = await resolveCallOrg(principal(), wanted)
  if (!result.ok) throw orgNotFound(slug)
  return result.org
}
