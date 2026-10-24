import { HTTPException } from "hono/http-exception"
import { jwtVerify } from "jose"
import { z } from "zod"
import { repositoryRevisionCheckoutKey } from "../../../../shared/workspace-checkout.js"
import type { Env } from "../config/env.js"
import { DEFAULT_CHECKOUT_KEY } from "../domain/repositories/paths.js"

export type VerifiedToken = {
  sub: string
  orgId: string
  principal: "user" | "service"
  repositoryRevisions?: Array<{ repositoryId: string; sha: string }>
  workspaceId?: string
  /**
   * The repositories that the Workspace links, as the backend minted them.
   * A Workspace token reads only these repositories, each at its published
   * checkout.
   */
  workspaceRepositoryIds?: string[]
}

/**
 * The checkout that a read of `repositoryId` uses:
 * - an ingestion run token (`repositoryRevisions`) reads its own `rev:<sha>`,
 * - a Workspace token reads the published checkout of a repository that the
 *   Workspace links, and gets 403 for any other repository,
 * - a token with no scope reads the published checkout.
 * A Workspace token needs `publishedCheckoutKey` from the repository row; a
 * call without it (an index write) gets 403, so a Workspace token never
 * writes the published checkout.
 */
export function checkoutKeyFromAuth(
  auth: Pick<
    VerifiedToken,
    "workspaceId" | "workspaceRepositoryIds" | "repositoryRevisions"
  >,
  repositoryId?: string,
  publishedCheckoutKey?: string,
): string {
  if (auth.repositoryRevisions) {
    const revisions = auth.repositoryRevisions.filter(
      (item) => item.repositoryId === repositoryId,
    )
    if (revisions.length !== 1 || !revisions[0])
      throw new HTTPException(403, {
        message: "Repository revision is not authorized",
      })
    return repositoryRevisionCheckoutKey(revisions[0].sha)
  }
  if (!auth.workspaceId) return publishedCheckoutKey ?? DEFAULT_CHECKOUT_KEY
  if (
    !workspaceLinksRepository(auth, repositoryId) ||
    publishedCheckoutKey === undefined
  )
    throw new HTTPException(403, {
      message: "Repository is not linked to this Workspace",
    })
  return publishedCheckoutKey
}

/** True when the Workspace token lists `repositoryId` exactly once. */
export function workspaceLinksRepository(
  auth: Pick<VerifiedToken, "workspaceRepositoryIds">,
  repositoryId: string | undefined,
): boolean {
  return (
    auth.workspaceRepositoryIds?.filter((id) => id === repositoryId).length ===
    1
  )
}

function readBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const [scheme, token] = authHeader.split(" ")
  if (scheme !== "Bearer" || !token) return null
  return token
}

function getSecret(env: Env): Uint8Array {
  if (!env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required for codesearch JWT verification")
  }
  return new TextEncoder().encode(env.AUTH_SECRET)
}

export async function verifyCodesearchJwt(input: {
  env: Env
  authorizationHeader: string | undefined
}): Promise<VerifiedToken | null> {
  const token = readBearerToken(input.authorizationHeader)
  if (!token) return null

  const { payload } = await jwtVerify(token, getSecret(input.env), {
    issuer: input.env.AUTH_ISSUER,
    audience: input.env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
  })

  const subject = payload.sub
  const orgId = payload.orgId
  const principal = payload.principal
  if (
    typeof subject !== "string" ||
    typeof orgId !== "string" ||
    (principal !== "user" && principal !== "service")
  ) {
    return null
  }

  const scope = z
    .object({
      repositoryRevisions: z
        .array(
          z.object({
            repositoryId: z.string().min(1),
            sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
          }),
        )
        .min(1)
        .optional(),
      workspaceId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional(),
      workspaceRepositoryIds: z.array(z.string().min(1)).min(1).optional(),
      // The claim shape of the previous release, while the backend and
      // codesearch can run different releases. Remove it in the next one.
      workspaceRevisions: z
        .array(
          z.object({
            repositoryId: z.string().min(1),
            sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
          }),
        )
        .min(1)
        .optional(),
    })
    .safeParse(payload)
  if (!scope.success) return null
  const { workspaceId } = scope.data
  if (scope.data.workspaceRepositoryIds && scope.data.workspaceRevisions)
    return null
  const workspaceRepositoryIds =
    scope.data.workspaceRepositoryIds ??
    scope.data.workspaceRevisions?.map((revision) => revision.repositoryId)
  if (
    (scope.data.repositoryRevisions &&
      Boolean(workspaceId || workspaceRepositoryIds)) ||
    Boolean(workspaceId) !== Boolean(workspaceRepositoryIds)
  )
    return null

  return {
    sub: subject,
    ...(scope.data.repositoryRevisions
      ? { repositoryRevisions: scope.data.repositoryRevisions }
      : {}),
    orgId,
    principal,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRepositoryIds ? { workspaceRepositoryIds } : {}),
  }
}

/**
 * Admit an immutable indexing target before any filesystem or database
 * mutation. Only an ingestion run token or a token with no scope can index;
 * a Workspace token is read-only.
 */
export function indexCheckoutFromAuth(
  auth: VerifiedToken,
  repositoryId: string,
  targetHash: string | undefined,
): string {
  if (auth.workspaceId)
    throw new HTTPException(403, {
      message: "Workspace scope is read-only",
    })
  const checkoutKey = checkoutKeyFromAuth(auth, repositoryId)
  const revision = auth.repositoryRevisions?.find(
    (item) => item.repositoryId === repositoryId,
  )
  if (revision && targetHash !== revision.sha)
    throw new HTTPException(403, {
      message: "Target commit does not match authenticated revision",
    })
  return checkoutKey
}
