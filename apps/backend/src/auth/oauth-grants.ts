import { and, desc, eq, inArray, or } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import {
  oauthAccessTokens,
  oauthConsents,
  oauthRefreshTokens,
} from "../db/schema/auth.js"
import { oauthGrantOrganizations } from "../db/schema/oauth_grant_organizations.js"
import { generateObjectId } from "../lib/id.js"
import { isOAuthGrantId, OAUTH_GRANT_ID_PREFIX } from "./oauth-organization.js"

export { isOAuthGrantId }

/** Replace the org set of a grant. An empty list allows no org. */
export async function setGrantOrganizations(
  grantId: string,
  organizationIds: string[],
): Promise<void> {
  await getSystemDb().transaction(async (tx) => {
    await tx
      .delete(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.grantId, grantId))
    if (organizationIds.length === 0) return
    await tx
      .insert(oauthGrantOrganizations)
      .values(
        organizationIds.map((organizationId) => ({ grantId, organizationId })),
      )
  })
}

/**
 * Replace the org set of a personal API key. An empty list removes the set,
 * so the key acts again on every current membership of its user.
 */
export async function setApiKeyOrganizations(
  apiKeyId: string,
  organizationIds: string[],
): Promise<void> {
  await getSystemDb().transaction(async (tx) => {
    await tx
      .delete(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.apiKeyId, apiKeyId))
    if (organizationIds.length === 0) return
    await tx
      .insert(oauthGrantOrganizations)
      .values(
        organizationIds.map((organizationId) => ({ apiKeyId, organizationId })),
      )
  })
}

/**
 * Revoke a grant: its org set, its consent, and its tokens. A JWT access token
 * that is still valid then resolves to an empty set, so each call is denied.
 */
export async function revokeOAuthGrant(grantId: string): Promise<void> {
  await getSystemDb().transaction(async (tx) => {
    await tx
      .delete(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.grantId, grantId))
    await tx
      .delete(oauthAccessTokens)
      .where(eq(oauthAccessTokens.referenceId, grantId))
    await tx
      .delete(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.referenceId, grantId))
    await tx.delete(oauthConsents).where(eq(oauthConsents.referenceId, grantId))
  })
}

/**
 * The `referenceId` for a consent of this user and client on one org. Better
 * Auth calls the consent hook on authorize and on consent, and finds the
 * consent row by this value, so the result must be stable: reuse the newest
 * consent of this client whose grant holds the org (or a legacy consent bound
 * to the org id). Otherwise make a new one-org grant.
 */
export async function findOrCreateOAuthGrant(input: {
  userId: string
  clientId: string | null
  organizationId: string
}): Promise<string> {
  const db = getSystemDb()
  if (input.clientId) {
    const grantsWithOrg = db
      .select({ grantId: oauthGrantOrganizations.grantId })
      .from(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.organizationId, input.organizationId))
    const rows = await db
      .select({ referenceId: oauthConsents.referenceId })
      .from(oauthConsents)
      .where(
        and(
          eq(oauthConsents.clientId, input.clientId),
          eq(oauthConsents.userId, input.userId),
          or(
            inArray(oauthConsents.referenceId, grantsWithOrg),
            eq(oauthConsents.referenceId, input.organizationId),
          ),
        ),
      )
      .orderBy(desc(oauthConsents.updatedAt))
    const grant = rows.find(
      (row) => row.referenceId && isOAuthGrantId(row.referenceId),
    )
    const found = grant?.referenceId ?? rows[0]?.referenceId
    if (found) return found
  }
  const grantId = generateObjectId(OAUTH_GRANT_ID_PREFIX)
  await setGrantOrganizations(grantId, [input.organizationId])
  return grantId
}
