import { and, asc, eq, inArray, type SQL } from "drizzle-orm"
import type { Context } from "hono"
import type { AppEnv } from "../app/env.js"
import { getSystemDb } from "../db/client.js"
import { members, organizations } from "../db/schema/auth.js"
import { oauthGrantOrganizations } from "../db/schema/oauth_grant_organizations.js"
import { isOAuthGrantId } from "./oauth-organization.js"

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

type CallOrgResult =
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
    oauthReferenceId: c.get("oauthReferenceId") ?? null,
    personalApiKeyId: c.get("personalApiKeyId") ?? null,
  }
}

/**
 * Resolve the one org that a call names (ADR-051). The principal's org set
 * intersected with live membership decides. An unknown org and an org that is
 * not allowed give the same `org_not_found`, so a caller cannot probe slugs.
 * With no org named, a principal whose allowed set holds one org uses it;
 * otherwise the call gets `org_required`.
 */
export async function resolveCallOrg(
  principal: CallPrincipal | null,
  orgSlug: string | null | undefined,
): Promise<CallOrgResult> {
  if (!principal) return { ok: false, error: "org_not_found" }
  const slug = orgSlug?.trim() || undefined
  const db = getSystemDb()
  const slugFilter = slug ? eq(organizations.slug, slug) : undefined

  if (principal.kind === "org_api_key") {
    const rows = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(and(eq(organizations.id, principal.orgId), slugFilter))
      .limit(1)
    return rows[0]
      ? { ok: true, org: rows[0] }
      : { ok: false, error: "org_not_found" }
  }

  const allowed = await allowedOrgFilter(principal)
  const rows = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, principal.userId),
      ),
    )
    .where(and(allowed.filter, slugFilter))
    .limit(2)

  if (slug) {
    return rows[0]
      ? { ok: true, org: rows[0] }
      : { ok: false, error: "org_not_found" }
  }
  if (!allowed.restricted) return { ok: false, error: "org_required" }
  if (rows.length === 0) return { ok: false, error: "org_not_found" }
  if (rows.length > 1 || !rows[0]) return { ok: false, error: "org_required" }
  return { ok: true, org: rows[0] }
}

/**
 * Every org that the principal can name in a call, in slug order: the
 * principal's org set ∩ live membership, as `resolveCallOrg` decides. The MCP
 * server instructions list these orgs.
 */
export async function listCallOrgs(
  principal: CallPrincipal | null,
): Promise<CallOrg[]> {
  if (!principal) return []
  const db = getSystemDb()
  const columns = { id: organizations.id, slug: organizations.slug }
  if (principal.kind === "org_api_key") {
    return db
      .select(columns)
      .from(organizations)
      .where(eq(organizations.id, principal.orgId))
  }
  const allowed = await allowedOrgFilter(principal)
  return db
    .select(columns)
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, principal.userId),
      ),
    )
    .where(allowed.filter)
    .orderBy(asc(organizations.slug))
}

async function allowedOrgFilter(
  principal: Extract<CallPrincipal, { kind: "user" }>,
): Promise<{ filter: SQL | undefined; restricted: boolean }> {
  const db = getSystemDb()
  const reference = principal.oauthReferenceId
  if (reference) {
    if (!isOAuthGrantId(reference)) {
      // Legacy grant: `referenceId` is one org id.
      return { filter: eq(organizations.id, reference), restricted: true }
    }
    return {
      filter: inArray(
        organizations.id,
        db
          .select({ id: oauthGrantOrganizations.organizationId })
          .from(oauthGrantOrganizations)
          .where(eq(oauthGrantOrganizations.grantId, reference)),
      ),
      restricted: true,
    }
  }
  const keyId = principal.personalApiKeyId
  if (keyId) {
    const keyOrgIds = (
      await db
        .select({ id: oauthGrantOrganizations.organizationId })
        .from(oauthGrantOrganizations)
        .where(eq(oauthGrantOrganizations.apiKeyId, keyId))
    ).map((row) => row.id)
    // A key with no set acts on every current membership (legacy keys).
    if (keyOrgIds.length > 0) {
      return { filter: inArray(organizations.id, keyOrgIds), restricted: true }
    }
  }
  return { filter: undefined, restricted: false }
}
