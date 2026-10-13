import { getContext } from "hono/context-storage"
import type { AppEnv } from "../../app/env.js"
import {
  type CallOrg,
  callPrincipalFromContext,
  listCallOrgs as listPrincipalOrgs,
  resolveCallOrg as resolvePrincipalOrg,
} from "../../auth/call-org.js"
import { orgNotFound } from "./tool-errors.js"

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
  const result = wanted
    ? await resolvePrincipalOrg(principal(), wanted)
    : { ok: false as const }
  if (!result.ok) throw orgNotFound(slug)
  return result.org
}
