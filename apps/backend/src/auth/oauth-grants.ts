import { and, desc, eq } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import {
  oauthAccessTokens,
  oauthConsents,
  oauthRefreshTokens,
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
 *   with its org set replaced by exactly the selected org.
 */
export async function resolveOAuthGrantReference(input: {
  userId: string
  clientId: string | null
  organizationId: string
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
  if (!input.consent) return newest ?? input.organizationId
  if (!input.clientId) {
    throw new Error("The OAuth consent request names no client")
  }
  const grantId =
    newest && isOAuthGrantId(newest)
      ? newest
      : generateObjectId(OAUTH_GRANT_ID_PREFIX)
  await setOrganizations({ grantId }, [input.organizationId])
  return grantId
}
