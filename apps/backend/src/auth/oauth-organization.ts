import { AsyncLocalStorage } from "node:async_hooks"

/** Legacy JWT claim: the one org id of a grant made before multi-org grants. */
export const OAUTH_ORGANIZATION_CLAIM =
  "https://ctxpipe.ai/organization_id" as const

/** JWT claim: the grant id (`ogr_*`) whose org set each call checks. */
export const OAUTH_GRANT_CLAIM = "https://ctxpipe.ai/grant_id" as const

/**
 * An OAuth grant id is the Better Auth `referenceId` of a consent and of the
 * tokens it issues. Before multi-org grants, `referenceId` was an org id; that
 * legacy form still works as a one-org set (ADR-051).
 */
export const OAUTH_GRANT_ID_PREFIX = "ogr"

export function isOAuthGrantId(referenceId: string): boolean {
  return referenceId.startsWith(`${OAUTH_GRANT_ID_PREFIX}_`)
}

/** Grant ids get the grant claim; a legacy org id keeps the org claim. */
export function oauthAccessTokenClaims(
  referenceId: string | null | undefined,
): Record<string, string> {
  if (!referenceId) return {}
  return isOAuthGrantId(referenceId)
    ? { [OAUTH_GRANT_CLAIM]: referenceId }
    : { [OAUTH_ORGANIZATION_CLAIM]: referenceId }
}

export type OAuthOrganizationBinding = {
  requiresSelection: boolean
  referenceId: string | null
}

type OAuthRequestContext = {
  /** `undefined` outside the consent endpoint; null when none was sent. */
  submittedOrganizationId: string | null | undefined
  /** OAuth client of the authorize flow, when the request names it. */
  clientId: string | null
}

const oauthRequestStorage = new AsyncLocalStorage<OAuthRequestContext>()

export function withOAuthRequestContext<T>(
  context: OAuthRequestContext,
  handler: () => Promise<T>,
): Promise<T> {
  return oauthRequestStorage.run(context, handler)
}

export function getOAuthConsentOrganizationId(): string | null | undefined {
  return oauthRequestStorage.getStore()?.submittedOrganizationId
}

export function getOAuthRequestClientId(): string | null {
  return oauthRequestStorage.getStore()?.clientId ?? null
}

/**
 * The OAuth client id of an auth request: the `client_id` query parameter on
 * authorize, else `client_id` in the signed `oauth_query` body field that the
 * consent, continue, and sign-in endpoints receive. Better Auth checks the
 * signature of `oauth_query`; this value only selects the user's own consent.
 */
export async function readOAuthRequestClientId(
  request: Request,
): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get("client_id")
  if (fromQuery) return fromQuery
  if (request.method !== "POST") return null
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return null
  }
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null)
  const oauthQuery =
    body && typeof body === "object" && "oauth_query" in body
      ? body.oauth_query
      : null
  if (typeof oauthQuery !== "string") return null
  return new URLSearchParams(oauthQuery).get("client_id")
}

/**
 * OAuth grants are tenant-bound at consent time. Better Auth 1.6.23
 * `/oauth2/continue` with `{ postLogin: true }` only selects that branch —
 * it does not skip `shouldRedirect` unless a server-issued, session-bound
 * marker (`ba_pl`) already exists. That marker is minted only when
 * authorize redirects to consent, so `requiresSelection` must be false
 * once a valid organization can be resolved. Multi-org users override on
 * the consent page; later session org switches cannot retarget the grant.
 */
export function selectOAuthOrganizationBinding(
  membershipIds: string[],
  activeOrganizationId: string | null | undefined,
): OAuthOrganizationBinding {
  if (membershipIds.length === 1) {
    return {
      requiresSelection: false,
      referenceId: membershipIds[0] ?? null,
    }
  }

  if (activeOrganizationId && membershipIds.includes(activeOrganizationId)) {
    return {
      requiresSelection: false,
      referenceId: activeOrganizationId,
    }
  }

  return {
    requiresSelection: true,
    referenceId: null,
  }
}

export function resolveOAuthConsentReferenceId(
  membershipIds: string[],
  activeOrganizationId: string | null | undefined,
  submittedOrganizationId: string | null | undefined,
): string | null {
  if (submittedOrganizationId !== undefined) {
    return submittedOrganizationId &&
      membershipIds.includes(submittedOrganizationId)
      ? submittedOrganizationId
      : null
  }
  return selectOAuthOrganizationBinding(membershipIds, activeOrganizationId)
    .referenceId
}
