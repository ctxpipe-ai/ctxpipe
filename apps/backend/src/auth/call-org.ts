import { and, asc, eq, type SQL } from "drizzle-orm"
import type { Context } from "hono"
import type { AppEnv } from "../app/env.js"
import { getSystemDb } from "../db/client.js"
import { members, organizations } from "../db/schema/auth.js"

/*
 * Stand-in for the multi-org grant module of CTX-586 P1-2a, with the same
 * exports. It reads the one-org grant of today (`oauthOrganizationId`). When
 * P1-2a merges, its file replaces this one; `listCallOrgs` must stay.
 */

/**
 * Who makes a call. A `user` principal with no OAuth reference and no personal
 * API key is a cookie or session-token principal.
 */
export type CallPrincipal =
  | { kind: "org_api_key"; orgId: string }
  | {
      kind: "user"
      userId: string
      /** Grant id (`ogr_*`), legacy org id, or null for an unbound grant. */
      oauthReferenceId: string | null
      personalApiKeyId: string | null
    }

export type CallOrg = { id: string; slug: string }

export type CallOrgResult =
  | { ok: true; org: CallOrg }
  | { ok: false; error: "org_not_found" | "org_required" }

export function callPrincipalFromContext(
  c: Context<AppEnv>,
): CallPrincipal | null {
  const orgApiKey = c.get("orgApiKey")
  if (orgApiKey) return { kind: "org_api_key", orgId: orgApiKey.orgId }
  const userId = c.get("user")?.id
  if (!userId) return null
  return {
    kind: "user",
    userId,
    oauthReferenceId: c.get("oauthOrganizationId") ?? null,
    personalApiKeyId: c.get("personalApiKeyId") ?? null,
  }
}

/** Allowed orgs ∩ live membership, in slug order; `slug` narrows to one. */
async function allowedOrgs(
  principal: CallPrincipal,
  slugFilter: SQL | undefined,
): Promise<{ rows: CallOrg[]; restricted: boolean }> {
  const db = getSystemDb()
  const columns = { id: organizations.id, slug: organizations.slug }
  if (principal.kind === "org_api_key") {
    const rows = await db
      .select(columns)
      .from(organizations)
      .where(and(eq(organizations.id, principal.orgId), slugFilter))
    return { rows, restricted: true }
  }
  const reference = principal.oauthReferenceId
  const rows = await db
    .select(columns)
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, principal.userId),
      ),
    )
    .where(
      and(reference ? eq(organizations.id, reference) : undefined, slugFilter),
    )
    .orderBy(asc(organizations.slug))
  return { rows, restricted: reference !== null }
}

/**
 * Resolve the one org that a call names (ADR-051). An unknown org and an org
 * that is not allowed give the same `org_not_found`. With no org named, a
 * principal whose allowed set holds one org uses it; otherwise the call gets
 * `org_required`.
 */
export async function resolveCallOrg(
  principal: CallPrincipal | null,
  orgSlug: string | null | undefined,
): Promise<CallOrgResult> {
  if (!principal) return { ok: false, error: "org_not_found" }
  const slug = orgSlug?.trim() || undefined
  const { rows, restricted } = await allowedOrgs(
    principal,
    slug ? eq(organizations.slug, slug) : undefined,
  )
  if (slug) {
    return rows[0]
      ? { ok: true, org: rows[0] }
      : { ok: false, error: "org_not_found" }
  }
  if (!restricted) return { ok: false, error: "org_required" }
  if (rows.length === 0) return { ok: false, error: "org_not_found" }
  if (rows.length > 1 || !rows[0]) return { ok: false, error: "org_required" }
  return { ok: true, org: rows[0] }
}

/** Every org that the principal can name in a call, in slug order. */
export async function listCallOrgs(
  principal: CallPrincipal | null,
): Promise<CallOrg[]> {
  if (!principal) return []
  return (await allowedOrgs(principal, undefined)).rows
}
