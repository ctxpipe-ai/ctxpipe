import { z } from "zod"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"

const renameSchema = z.object({
  from: z.string(),
  to: z.string(),
})

const cloneCheckoutResponseSchema = z.object({
  ok: z.literal(true),
  targetHash: z.string(),
  ingestMode: z.enum(["full", "partial"]),
  changedPaths: z.array(z.string()),
  deletedPaths: z.array(z.string()),
  renames: z.array(renameSchema),
})

const detectLanguagesResponseSchema = z.object({
  ok: z.literal(true),
  detectedLanguages: z.array(z.string()),
  languagesToIndex: z.array(z.string()),
})

const okResponseSchema = z.object({ ok: z.literal(true) })

export type CodesearchIndexAuth = {
  repositoryId: string
  orgId: string
  workspaceId?: string
}

async function codesearchPhaseFetch(
  path: string,
  auth: CodesearchIndexAuth,
  init: RequestInit,
): Promise<Response> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return withTransientHttpRetry(
    async () => {
      const token = await signUpstreamJwt({
        env,
        audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
        claims: {
          sub: `repo:${auth.repositoryId}`,
          orgId: auth.orgId,
          principal: "service",
          ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
        },
      })
      return fetch(`${codesearchBaseUrl()}/${auth.repositoryId}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      })
    },
    { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
  )
}

async function parseOrThrow<T>(
  res: Response,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const bodyText = await res.text()
  if (!res.ok) {
    let detail = bodyText.trim()
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        detail = parsed.error
      }
    } catch {
      // non-JSON
    }
    throw new Error(`${label} failed with status ${res.status}: ${detail}`)
  }
  let json: unknown
  try {
    json = JSON.parse(bodyText) as unknown
  } catch {
    throw new Error(`${label} returned non-JSON body`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`${label} returned unexpected JSON body`)
  }
  return parsed.data
}

export async function codesearchIndexCloneCheckout(
  auth: CodesearchIndexAuth,
  body: {
    githubToken?: string
    targetHash?: string
    fromHash?: string
    checkoutKey?: string
  },
): Promise<{
  targetHash: string
  ingestMode: "full" | "partial"
  changedPaths: string[]
  deletedPaths: string[]
  renames: Array<{ from: string; to: string }>
}> {
  const res = await codesearchPhaseFetch("/index/clone-checkout", auth, {
    method: "POST",
    body: JSON.stringify(body),
  })
  const data = await parseOrThrow(
    res,
    cloneCheckoutResponseSchema,
    "codesearch index clone-checkout",
  )
  return {
    targetHash: data.targetHash,
    ingestMode: data.ingestMode,
    changedPaths: data.changedPaths,
    deletedPaths: data.deletedPaths,
    renames: data.renames,
  }
}

export async function codesearchIndexZoekt(
  auth: CodesearchIndexAuth,
): Promise<void> {
  const res = await codesearchPhaseFetch("/index/zoekt", auth, {
    method: "POST",
    body: JSON.stringify({}),
  })
  await parseOrThrow(res, okResponseSchema, "codesearch index zoekt")
}

export async function codesearchIndexDetectLanguages(
  auth: CodesearchIndexAuth,
  body: {
    ingestMode: "full" | "partial"
    changedPaths: string[]
    deletedPaths: string[]
    renames: Array<{ from: string; to: string }>
  },
): Promise<{ detectedLanguages: string[]; languagesToIndex: string[] }> {
  const res = await codesearchPhaseFetch("/index/detect-languages", auth, {
    method: "POST",
    body: JSON.stringify(body),
  })
  const data = await parseOrThrow(
    res,
    detectLanguagesResponseSchema,
    "codesearch index detect-languages",
  )
  return {
    detectedLanguages: data.detectedLanguages,
    languagesToIndex: data.languagesToIndex,
  }
}

export async function codesearchIndexScipLang(
  auth: CodesearchIndexAuth,
  language: string,
  detectedLanguages: string[],
): Promise<void> {
  const res = await codesearchPhaseFetch(
    `/index/scip/${encodeURIComponent(language)}`,
    auth,
    {
      method: "POST",
      body: JSON.stringify({ detectedLanguages }),
    },
  )
  await parseOrThrow(res, okResponseSchema, `codesearch index scip:${language}`)
}

export async function codesearchIndexMergeScip(
  auth: CodesearchIndexAuth,
  detectedLanguages: string[],
): Promise<void> {
  const res = await codesearchPhaseFetch("/index/merge-scip", auth, {
    method: "POST",
    body: JSON.stringify({ detectedLanguages }),
  })
  await parseOrThrow(res, okResponseSchema, "codesearch index merge-scip")
}
