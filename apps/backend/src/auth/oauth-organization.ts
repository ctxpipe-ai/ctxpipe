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
  /**
   * The orgs that the consent ticks. `undefined` outside the consent
   * endpoint; null when none was sent.
   */
  submittedOrganizationIds: string[] | null | undefined
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

export function getOAuthConsentOrganizationIds(): string[] | null | undefined {
  return oauthRequestStorage.getStore()?.submittedOrganizationIds
}

/**
 * The org ids of the `x-ctxpipe-oauth-organization` header: one id, or a
 * comma-separated list. An empty header gives null.
 */
export function parseOAuthConsentOrganizationIds(
  header: string | undefined,
): string[] | null {
  const ids = [
    ...new Set(
      (header ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ]
  return ids.length > 0 ? ids : null
}

export function getOAuthRequestClientId(): string | null {
  return oauthRequestStorage.getStore()?.clientId ?? null
}

/**
 * The OAuth client id of an auth request: the `client_id` query parameter on
 * a GET authorize, or `client_id` in the signed `oauth_query` body field of a
 * POST (consent, continue, sign-in). A POST never reads the URL, because
 * Better Auth checks only the signature of `oauth_query`.
 */
export async function readOAuthRequestClientId(
  request: Request,
): Promise<string | null> {
  if (request.method === "GET") {
    return new URL(request.url).searchParams.get("client_id")
  }
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

/**
 * The org set of a consent. In the consent request, every ticked org must be
 * a membership, else null (the consent is refused). Outside it, the one org
 * of `selectOAuthOrganizationBinding`.
 */
export function resolveOAuthConsentOrganizationIds(
  membershipIds: string[],
  activeOrganizationId: string | null | undefined,
  submittedOrganizationIds: string[] | null | undefined,
): string[] | null {
  if (submittedOrganizationIds !== undefined) {
    return submittedOrganizationIds &&
      submittedOrganizationIds.length > 0 &&
      submittedOrganizationIds.every((id) => membershipIds.includes(id))
      ? submittedOrganizationIds
      : null
  }
  const { referenceId } = selectOAuthOrganizationBinding(
    membershipIds,
    activeOrganizationId,
  )
  return referenceId ? [referenceId] : null
}
