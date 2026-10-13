import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { orgNotFound } from "./tool-errors.js"

export type CallOrg = { id: string; slug: string }

/**
 * The orgs that this connection can read. Today a connection has one org,
 * which `withNetworkOrgContext` resolves from the grant, the API key, or
 * `?orgSlug=`. The multi-org grant (CTX-586 P1-2a) replaces this body with
 * the grant org set ∩ live membership; callers do not change.
 */
export async function listCallOrgs(): Promise<CallOrg[]> {
  return [{ id: requireCurrentOrgId(), slug: requireCurrentOrgSlug() }]
}

/**
 * The org that the `org` argument of one tool call names (ADR-051 §3). An
 * unknown org and an org outside the connection give the same
 * `org_not_found` error.
 */
export async function resolveCallOrg(slug: string): Promise<CallOrg> {
  const wanted = slug.trim().toLowerCase()
  const org = (await listCallOrgs()).find(
    (candidate) => candidate.slug.toLowerCase() === wanted,
  )
  if (!org) throw orgNotFound(slug)
  return org
}
