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

/** The Connected apps page, for a principal that is an OAuth connection. */
function connectedAppsUrl(): string | null {
  const c = getContext<AppEnv>()
  if (!c.get("oauthReferenceId")) return null
  const base = c.get("env").AUTH_BASE_URL.replace(/\/$/, "")
  return `${base}/.auth/account/connected-apps`
}

/** The orgs that the principal of this request can name in a tool call. */
export function listToolOrgs(): Promise<CallOrg[]> {
  return listCallOrgs(principal())
}

/**
 * The org that the `org` argument of one tool call names (ADR-051 §3). The
 * principal's allowed orgs ∩ live membership decide; `?orgSlug=` on the URL
 * has no effect. An unknown org and an org outside the connection give the
 * same `org_not_found` error. For an OAuth connection, the error points the
 * user to Connected apps.
 */
export async function requireToolOrg(slug: string): Promise<CallOrg> {
  const wanted = slug.trim().toLowerCase()
  if (!wanted) throw orgRequired()
  const result = await resolveCallOrg(principal(), wanted)
  if (!result.ok) throw orgNotFound(slug, connectedAppsUrl())
  return result.org
}
