import { HTTPException } from "hono/http-exception"
import { jwtVerify } from "jose"
import { z } from "zod"
import { repositoryRevisionCheckoutKey } from "../../../../shared/workspace-checkout.js"
import type { Env } from "../config/env.js"
import {
  DEFAULT_CHECKOUT_KEY,
  workspaceCheckoutKey,
} from "../domain/repositories/paths.js"

export type VerifiedToken = {
  sub: string
  orgId: string
  principal: "user" | "service"
  repositoryRevisions?: Array<{ repositoryId: string; sha: string }>
  workspaceId?: string
  legacyWorkspace?: true
  workspaceRevisions?: Array<{ repositoryId: string; sha: string }>
}

export function checkoutKeyFromAuth(
  auth: Pick<
    VerifiedToken,
    | "workspaceId"
    | "workspaceRevisions"
    | "legacyWorkspace"
    | "repositoryRevisions"
  >,
  repositoryId?: string,
  publishedCheckoutKey = DEFAULT_CHECKOUT_KEY,
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
  if (!auth.workspaceId) return publishedCheckoutKey
  if (auth.legacyWorkspace && !auth.workspaceRevisions)
    return workspaceCheckoutKey(auth.workspaceId)
  if (!auth.workspaceRevisions)
    throw new HTTPException(403, {
      message: "Workspace revision is not authorized",
    })
  const revisions = auth.workspaceRevisions.filter(
    (revision) => revision.repositoryId === repositoryId,
  )
  if (revisions.length !== 1 || !revisions[0])
    throw new HTTPException(403, {
      message: "Repository revision is not authorized",
    })
  return workspaceCheckoutKey(auth.workspaceId, revisions[0].sha)
}

export function checkoutKeysFromAuth(auth: VerifiedToken): string[] {
  if (auth.repositoryRevisions)
    return auth.repositoryRevisions.map((item) =>
      repositoryRevisionCheckoutKey(item.sha),
    )
  return auth.workspaceRevisions && auth.workspaceId
    ? auth.workspaceRevisions.map((revision) =>
        workspaceCheckoutKey(auth.workspaceId as string, revision.sha),
      )
    : [checkoutKeyFromAuth(auth)]
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
      legacyWorkspace: z.literal(true).optional(),
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
  if (
    !scope.success ||
    (scope.data.repositoryRevisions &&
      Boolean(
        scope.data.workspaceId ||
          scope.data.workspaceRevisions ||
          scope.data.legacyWorkspace,
      )) ||
    ((scope.data.workspaceRevisions || scope.data.legacyWorkspace) &&
      !scope.data.workspaceId) ||
    (Boolean(scope.data.workspaceId) &&
      Boolean(scope.data.workspaceRevisions) ===
        Boolean(scope.data.legacyWorkspace))
  )
    return null
  const { workspaceId, workspaceRevisions, legacyWorkspace } = scope.data

  return {
    sub: subject,
    ...(scope.data.repositoryRevisions
      ? { repositoryRevisions: scope.data.repositoryRevisions }
      : {}),
    orgId,
    principal,
    ...(workspaceId ? { workspaceId } : {}),
    ...(legacyWorkspace ? { legacyWorkspace } : {}),
    ...(workspaceRevisions ? { workspaceRevisions } : {}),
  }
}

/** Admit an immutable indexing target before any filesystem or database mutation. */
export function indexCheckoutFromAuth(
  auth: VerifiedToken,
  repositoryId: string,
  targetHash: string | undefined,
): string {
  const checkoutKey = checkoutKeyFromAuth(auth, repositoryId)
  if (auth.workspaceId && !auth.workspaceRevisions)
    throw new HTTPException(403, {
      message: "Legacy workspace scope is read-only",
    })
  const revision = (auth.repositoryRevisions ?? auth.workspaceRevisions)?.find(
    (item) => item.repositoryId === repositoryId,
  )
  if (revision && targetHash !== revision.sha)
    throw new HTTPException(403, {
      message: "Target commit does not match authenticated revision",
    })
  return checkoutKey
}
