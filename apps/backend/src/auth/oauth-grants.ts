import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm"

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

/** One OAuth consent of a user, as the Connected apps page shows it. */
export type ConnectedApp = {
  /** The consent id. */
  id: string
  /**
   * A consent from before multi-org grants: its reference is one org id or null.
   * The user can revoke it, but not edit its orgs.
   */
  legacy: boolean
  clientId: string
  clientName: string | null
  scopes: string[]
  /** The consent's orgs ∩ the user's live memberships, in slug order. */
  organizations: { id: string; slug: string; name: string }[]
  connectedAt: Date | null
}

/** The OAuth consents of one user, newest first, legacy ones too. */
export async function listConnectedApps(
  userId: string,
): Promise<ConnectedApp[]> {
  const db = getSystemDb()
  const consents = await db
    .select({
      id: oauthConsents.id,
      referenceId: oauthConsents.referenceId,
      clientId: oauthConsents.clientId,
      clientName: oauthClients.name,
      scopes: oauthConsents.scopes,
      connectedAt: oauthConsents.createdAt,
    })
    .from(oauthConsents)
    // A left join: a consent whose client is gone can still be revoked.
    .leftJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .where(eq(oauthConsents.userId, userId))
    .orderBy(desc(oauthConsents.updatedAt))

  if (consents.length === 0) return []
  const grantIds = consents.flatMap(({ referenceId }) =>
    referenceId && isOAuthGrantId(referenceId) ? [referenceId] : [],
  )
  const memberOrgs = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, userId),
      ),
    )
    .orderBy(asc(organizations.slug))
  const grantRows =
    grantIds.length > 0
      ? await db
          .select({
            grantId: oauthGrantOrganizations.grantId,
            organizationId: oauthGrantOrganizations.organizationId,
          })
          .from(oauthGrantOrganizations)
          .where(inArray(oauthGrantOrganizations.grantId, grantIds))
      : []
  return consents.map(({ referenceId, ...row }) => {
    const legacy = !referenceId || !isOAuthGrantId(referenceId)
    const orgIds = new Set(
      legacy
        ? [referenceId]
        : grantRows
            .filter((grant) => grant.grantId === referenceId)
            .map((grant) => grant.organizationId),
    )
    return {
      ...row,
      clientName: row.clientName ?? null,
      legacy,
      organizations: memberOrgs.filter((org) => orgIds.has(org.id)),
    }
  })
}

/** The user's own consent, or null. */
async function ownConsent(userId: string, consentId: string) {
  const [row] = await getSystemDb()
    .select({
      clientId: oauthConsents.clientId,
      referenceId: oauthConsents.referenceId,
    })
    .from(oauthConsents)
    .where(
      and(eq(oauthConsents.id, consentId), eq(oauthConsents.userId, userId)),
    )
    .limit(1)
  return row ?? null
}

/**
 * Replace the org set of one of the user's grants. Each org must be a live
 * membership of the user. A legacy consent has no org set to edit.
 */
export async function setConnectedAppOrganizations(input: {
  userId: string
  consentId: string
  organizationIds: string[]
}): Promise<"ok" | "not_found" | "legacy" | "not_member"> {
  const { userId } = input
  const consent = await ownConsent(userId, input.consentId)
  if (!consent) return "not_found"
  if (!consent.referenceId || !isOAuthGrantId(consent.referenceId))
    return "legacy"
  const organizationIds = [...new Set(input.organizationIds)]
  const memberships = await getSystemDb()
    .select({ id: members.organizationId })
    .from(members)
    .where(
      and(
        eq(members.userId, userId),
        inArray(members.organizationId, organizationIds),
      ),
    )
  if (memberships.length !== organizationIds.length) return "not_member"
  await setOrganizations({ grantId: consent.referenceId }, organizationIds)
  return "ok"
}

/**
 * Revoke one of the user's consents. A grant goes through `revokeOAuthGrant`.
 * A legacy consent (an org-id reference that many users share) deletes only
 * this user's consent and the tokens of that user and client.
 */
export async function revokeConnectedApp(input: {
  userId: string
  consentId: string
}): Promise<boolean> {
  const { userId, consentId } = input
  const consent = await ownConsent(userId, consentId)
  if (!consent) return false
  if (consent.referenceId && isOAuthGrantId(consent.referenceId)) {
    await revokeOAuthGrant({ grantId: consent.referenceId, userId })
    return true
  }
  const { clientId, referenceId } = consent
  await getSystemDb().transaction(async (tx) => {
    await tx
      .delete(oauthAccessTokens)
      .where(
        and(
          referenceId === null
            ? isNull(oauthAccessTokens.referenceId)
            : eq(oauthAccessTokens.referenceId, referenceId),
          eq(oauthAccessTokens.userId, userId),
          eq(oauthAccessTokens.clientId, clientId),
        ),
      )
    await tx
      .delete(oauthRefreshTokens)
      .where(
        and(
          referenceId === null
            ? isNull(oauthRefreshTokens.referenceId)
            : eq(oauthRefreshTokens.referenceId, referenceId),
          eq(oauthRefreshTokens.userId, userId),
          eq(oauthRefreshTokens.clientId, clientId),
        ),
      )
    await tx.delete(oauthConsents).where(eq(oauthConsents.id, consentId))
  })
  return true
}
