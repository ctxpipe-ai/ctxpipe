import { and, asc, desc, eq, inArray, like } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import {
  members,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  organizations,
} from "../db/schema/auth.js"
import { oauthGrantOrganizations } from "../db/schema/oauth_grant_organizations.js"
import { generateObjectId } from "../lib/id.js"
import { isOAuthGrantId, OAUTH_GRANT_ID_PREFIX } from "./oauth-organization.js"

type OrgSetOwner = { grantId: string } | { apiKeyId: string }

/**
 * Replace the org set of a grant or a personal API key. An empty list allows
 * no org for a grant, and gives a personal API key every membership again.
 */
export async function setOrganizations(
  owner: OrgSetOwner,
  organizationIds: string[],
): Promise<void> {
  const ownerFilter =
    "grantId" in owner
      ? eq(oauthGrantOrganizations.grantId, owner.grantId)
      : eq(oauthGrantOrganizations.apiKeyId, owner.apiKeyId)
  await getSystemDb().transaction(async (tx) => {
    await tx.delete(oauthGrantOrganizations).where(ownerFilter)
    if (organizationIds.length === 0) return
    await tx
      .insert(oauthGrantOrganizations)
      .values(
        organizationIds.map((organizationId) => ({ ...owner, organizationId })),
      )
  })
}

/**
 * Revoke one user's grant: its org set, and that user's consent and tokens.
 * A JWT access token that is still valid then resolves to an empty set, so
 * each call is denied. Only a grant id is accepted: a legacy org-id reference
 * is shared by many users and must not be deleted this way.
 */
export async function revokeOAuthGrant(input: {
  grantId: string
  userId: string
}): Promise<void> {
  const { grantId, userId } = input
  if (!isOAuthGrantId(grantId)) {
    throw new Error("revokeOAuthGrant needs an OAuth grant id")
  }
  await getSystemDb().transaction(async (tx) => {
    await tx
      .delete(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.grantId, grantId))
    await tx
      .delete(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.referenceId, grantId),
          eq(oauthAccessTokens.userId, userId),
        ),
      )
    await tx
      .delete(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.referenceId, grantId),
          eq(oauthRefreshTokens.userId, userId),
        ),
      )
    await tx
      .delete(oauthConsents)
      .where(
        and(
          eq(oauthConsents.referenceId, grantId),
          eq(oauthConsents.userId, userId),
        ),
      )
  })
}

/**
 * The Better Auth `referenceId` for this user and client. Better Auth calls
 * the consent hook on authorize, on consent, and after sign-in; it finds the
 * consent row by this value.
 *
 * - Outside the consent request: the newest consent reference of this client,
 *   else the org id. A missing consent then sends the user to the consent
 *   page, and a skipConsent client gets a legacy one-org reference. No grant
 *   is made here, so no grant is left without a consent.
 * - In the consent request: the grant of the newest consent (or a new grant),
 *   with its org set replaced by exactly the selected orgs.
 */
export async function resolveOAuthGrantReference(input: {
  userId: string
  clientId: string | null
  /** At least one org. Outside the consent request, only the first is used. */
  organizationIds: string[]
  consent: boolean
}): Promise<string> {
  const db = getSystemDb()
  const newest = input.clientId
    ? (
        await db
          .select({ referenceId: oauthConsents.referenceId })
          .from(oauthConsents)
          .where(
            and(
              eq(oauthConsents.clientId, input.clientId),
              eq(oauthConsents.userId, input.userId),
            ),
          )
          .orderBy(desc(oauthConsents.updatedAt))
          .limit(1)
      )[0]?.referenceId
    : null
  const [firstOrganizationId] = input.organizationIds
  if (!firstOrganizationId) {
    throw new Error("An OAuth grant reference needs at least one org")
  }
  if (!input.consent) return newest ?? firstOrganizationId
  if (!input.clientId) {
    throw new Error("The OAuth consent request names no client")
  }
  const grantId =
    newest && isOAuthGrantId(newest)
      ? newest
      : generateObjectId(OAUTH_GRANT_ID_PREFIX)
  await setOrganizations({ grantId }, input.organizationIds)
  return grantId
}

/** One OAuth grant of a user, as the Connected apps page shows it. */
export type ConnectedApp = {
  grantId: string
  clientId: string
  clientName: string | null
  scopes: string[]
  /** The grant's org set ∩ the user's live memberships, in slug order. */
  organizations: { id: string; slug: string; name: string }[]
  connectedAt: Date | null
}

/**
 * The OAuth grants (`ogr_*` consents) of one user, newest first. A legacy
 * consent (an org-id reference) is not listed: it has no editable org set.
 */
export async function listConnectedApps(
  userId: string,
  grantId?: string,
): Promise<ConnectedApp[]> {
  const db = getSystemDb()
  const consents = await db
    .select({
      grantId: oauthConsents.referenceId,
      clientId: oauthConsents.clientId,
      clientName: oauthClients.name,
      scopes: oauthConsents.scopes,
      connectedAt: oauthConsents.createdAt,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .where(
      and(
        eq(oauthConsents.userId, userId),
        grantId
          ? eq(oauthConsents.referenceId, grantId)
          : like(oauthConsents.referenceId, `${OAUTH_GRANT_ID_PREFIX}\\_%`),
      ),
    )
    .orderBy(desc(oauthConsents.updatedAt))
  const grants = consents.flatMap((row) =>
    row.grantId && isOAuthGrantId(row.grantId)
      ? [{ ...row, grantId: row.grantId }]
      : [],
  )
  if (grants.length === 0) return []
  const orgRows = await db
    .select({
      grantId: oauthGrantOrganizations.grantId,
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(oauthGrantOrganizations)
    .innerJoin(
      organizations,
      eq(organizations.id, oauthGrantOrganizations.organizationId),
    )
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, userId),
      ),
    )
    .where(
      inArray(
        oauthGrantOrganizations.grantId,
        grants.map((grant) => grant.grantId),
      ),
    )
    .orderBy(asc(organizations.slug))
  return grants.map((grant) => ({
    ...grant,
    organizations: orgRows
      .filter((row) => row.grantId === grant.grantId)
      .map(({ id, slug, name }) => ({ id, slug, name })),
  }))
}

/**
 * Replace the org set of one of the user's grants. Each org that the set
 * adds must be a membership of the user. An org that the set keeps needs no
 * check: the per-call membership check denies it when the user left.
 */
export async function setConnectedAppOrganizations(input: {
  userId: string
  grantId: string
  organizationIds: string[]
}): Promise<"ok" | "not_found" | "not_member" | "empty"> {
  const { userId, grantId } = input
  const organizationIds = [...new Set(input.organizationIds)]
  if (organizationIds.length === 0) return "empty"
  if (!(await ownsGrant(userId, grantId))) return "not_found"
  const db = getSystemDb()
  const current = new Set(
    (
      await db
        .select({ id: oauthGrantOrganizations.organizationId })
        .from(oauthGrantOrganizations)
        .where(eq(oauthGrantOrganizations.grantId, grantId))
    ).map((row) => row.id),
  )
  const added = organizationIds.filter((id) => !current.has(id))
  if (added.length > 0) {
    const memberships = await db
      .select({ id: members.organizationId })
      .from(members)
      .where(
        and(eq(members.userId, userId), inArray(members.organizationId, added)),
      )
    if (memberships.length !== added.length) return "not_member"
  }
  await setOrganizations({ grantId }, organizationIds)
  return "ok"
}

/** Revoke one of the user's grants. False when the user has no such grant. */
export async function revokeConnectedApp(input: {
  userId: string
  grantId: string
}): Promise<boolean> {
  if (!(await ownsGrant(input.userId, input.grantId))) return false
  await revokeOAuthGrant(input)
  return true
}

async function ownsGrant(userId: string, grantId: string): Promise<boolean> {
  if (!isOAuthGrantId(grantId)) return false
  const [row] = await getSystemDb()
    .select({ id: oauthConsents.id })
    .from(oauthConsents)
    .where(
      and(
        eq(oauthConsents.userId, userId),
        eq(oauthConsents.referenceId, grantId),
      ),
    )
    .limit(1)
  return row !== undefined
}
