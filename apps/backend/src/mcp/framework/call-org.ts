import { getContext } from "hono/context-storage"
import type { AppEnv } from "../../app/env.js"
import {
  type CallOrg,
  callPrincipalFromContext,
  listCallOrgs as listPrincipalOrgs,
  resolveCallOrg as resolvePrincipalOrg,
} from "../../auth/call-org.js"
import { requireCurrentOrgId } from "../../auth/context.js"
import { orgNotFound, orgRequired } from "./tool-errors.js"

export type { CallOrg }

function principal() {
  return callPrincipalFromContext(getContext<AppEnv>())
}

/** The orgs that the principal of this request can name in a tool call. */
export async function listCallOrgs(): Promise<CallOrg[]> {
  return listPrincipalOrgs(principal())
}

/**
 * The org that the `org` argument of one tool call names (ADR-051 §3). The
 * principal's allowed orgs ∩ live membership decide; `?orgSlug=` on the URL
 * has no effect. An unknown org and an org outside the connection give the
 * same `org_not_found` error.
 */
export async function resolveCallOrg(slug: string): Promise<CallOrg> {
  const wanted = slug.trim().toLowerCase()
  if (!wanted) throw orgRequired()
  const result = await resolvePrincipalOrg(principal(), wanted)
  if (!result.ok) throw orgNotFound(slug)
  return result.org
}

/**
 * The default org of the request (`?orgSlug=`, or the only allowed org), or
 * undefined when the connection has several orgs and the URL names none.
 * Only `ctx_advisor` uses it; the read tools name their org.
 */
export function currentDefaultOrgId(): string | undefined {
  try {
    return requireCurrentOrgId()
  } catch {
    return undefined
  }
}
