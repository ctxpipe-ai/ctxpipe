import { z } from "zod"
import { HTTPException } from "hono/http-exception"
import { jwtVerify } from "jose"
import type { Env } from "../config/env.js"
import {
  DEFAULT_CHECKOUT_KEY,
  workspaceCheckoutKey,
} from "../domain/repositories/paths.js"

export type VerifiedToken = {
  sub: string
  orgId: string
  principal: "user" | "service"
  workspaceId?: string
  workspaceRevisions?: Array<{ repositoryId: string; sha: string }>
}

export function checkoutKeyFromAuth(
  auth: Pick<VerifiedToken, "workspaceId" | "workspaceRevisions">,
  repositoryId?: string,
): string {
  if (!auth.workspaceId) return DEFAULT_CHECKOUT_KEY
  if (!auth.workspaceRevisions) return workspaceCheckoutKey(auth.workspaceId)
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
      workspaceId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional(),
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
    (scope.data.workspaceRevisions && !scope.data.workspaceId)
  )
    return null
  const { workspaceId, workspaceRevisions } = scope.data

  return {
    sub: subject,
    orgId,
    principal,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRevisions ? { workspaceRevisions } : {}),
  }
}
