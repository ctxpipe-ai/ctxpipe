import { z } from "zod"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { parseEnv } from "../../config/env.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { readCodesearchError } from "../../lib/codesearchError.js"
import {
  CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
  isCodesearchTaskDeath,
  isHeadersTimeout,
  isMemoryFitFailure,
  userFacingIndexingError,
} from "../../lib/memoryFitError.js"
import { withTransientHttpRetry } from "../../lib/withTransientHttpRetry.js"
import { log } from "../../observability/logger.js"
import { RepositoryGoneError } from "./repositoryGone.js"

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
const scipLangResponseSchema = z.object({
  ok: z.literal(true),
  issue: z.string().optional(),
})
const mergeScipResponseSchema = z.object({
  ok: z.literal(true),
  shardCount: z.number().int().nonnegative(),
})

export class CodesearchAdmissionBusyError extends Error {
  override readonly name = "CodesearchAdmissionBusyError"
}

export function isCodesearchAdmissionBusyError(
  error: unknown,
): error is CodesearchAdmissionBusyError {
  return error instanceof CodesearchAdmissionBusyError
}

export type CodesearchIndexAuth = {
  repositoryId: string
  orgId: string
  repositoryRevisions?: Array<{ repositoryId: string; sha: string }>
  workspaceId?: string
  workspaceRevisions?: Array<{ repositoryId: string; sha: string }>
}

async function authorizedCodesearchFetch(
  path: string,
  auth: CodesearchIndexAuth,
  init: RequestInit,
): Promise<Response> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${auth.repositoryId}`,
      orgId: auth.orgId,
      principal: "service",
      ...(auth.repositoryRevisions
        ? { repositoryRevisions: auth.repositoryRevisions }
        : {}),
      ...(auth.workspaceRevisions
        ? { workspaceRevisions: auth.workspaceRevisions }
        : {}),
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
}

async function codesearchPhaseFetch(
  path: string,
  auth: CodesearchIndexAuth,
  init: RequestInit,
): Promise<Response> {
  try {
    return await withTransientHttpRetry(
      () => authorizedCodesearchFetch(path, auth, init),
      { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
    )
  } catch (error) {
    if (isMemoryFitFailure(error) || isCodesearchTaskDeath(error)) {
      log.info({
        step: "repository-index.memory_exceeded",
        path,
        repositoryId: auth.repositoryId,
        error: userFacingIndexingError(error),
      })
      throw new Error(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY, { cause: error })
    }
    throw error
  }
}

async function parseOrThrow<T>(
  res: Response,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  if (!res.ok) {
    const failure = await readCodesearchError(res)
    if (failure.code === "repository_not_found") {
      throw new RepositoryGoneError(failure.message || undefined)
    }
    const combined = `${label} failed with status ${failure.status}: ${failure.message}`
    if (failure.status === 429) {
      throw new CodesearchAdmissionBusyError(combined)
    }
    throw new Error(
      isMemoryFitFailure(combined) || isMemoryFitFailure(failure.message)
        ? CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY
        : combined,
    )
  }
  const bodyText = await res.text()
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

/**
 * Build one language's SCIP shard. `issue` is a public-facing note when the
 * shard was built but is incomplete (some TypeScript projects failed).
 */
const scipPhaseStatusSchema = z.object({
  status: z.enum(["running", "succeeded", "failed"]),
  issue: z.string().optional(),
  error: z.string().optional(),
})

async function waitForScipPhase(
  auth: CodesearchIndexAuth,
  language: string,
): Promise<{ issue?: string }> {
  const path = `/index/scip/${encodeURIComponent(language)}`
  for (;;) {
    try {
      const res = await authorizedCodesearchFetch(path, auth, { method: "GET" })
      if (res.status === 404) {
        throw new Error(`codesearch index scip:${language} status was lost`)
      }
      if (!res.ok) {
        const failure = await readCodesearchError(res)
        throw new Error(
          `codesearch index scip:${language} status failed with status ${failure.status}: ${failure.message}`,
        )
      }
      const parsed = scipPhaseStatusSchema.safeParse(await res.json())
      if (!parsed.success) {
        throw new Error(
          `codesearch index scip:${language} returned an unexpected status`,
        )
      }
      if (parsed.data.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        continue
      }
      if (parsed.data.status === "succeeded") {
        return parsed.data.issue ? { issue: parsed.data.issue } : {}
      }
      const error = new Error(parsed.data.error ?? "SCIP indexing failed")
      if (isMemoryFitFailure(error)) {
        throw new Error(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY, { cause: error })
      }
      throw error
    } catch (error) {
      if (!isHeadersTimeout(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}

export async function codesearchIndexScipLang(
  auth: CodesearchIndexAuth,
  language: string,
  detectedLanguages: string[],
): Promise<{ issue?: string }> {
  const res = await codesearchPhaseFetch(
    `/index/scip/${encodeURIComponent(language)}`,
    auth,
    {
      method: "POST",
      body: JSON.stringify({ detectedLanguages }),
    },
  )
  if (res.status === 202) {
    return waitForScipPhase(auth, language)
  }
  const { issue } = await parseOrThrow(
    res,
    scipLangResponseSchema,
    `codesearch index scip:${language}`,
  )
  return issue ? { issue } : {}
}

export async function codesearchIndexMergeScip(
  auth: CodesearchIndexAuth,
  detectedLanguages: string[],
  languagesToMerge?: string[],
): Promise<{ shardCount: number }> {
  const res = await codesearchPhaseFetch("/index/merge-scip", auth, {
    method: "POST",
    body: JSON.stringify({
      detectedLanguages,
      ...(languagesToMerge !== undefined ? { languagesToMerge } : {}),
    }),
  })
  return parseOrThrow(
    res,
    mergeScipResponseSchema,
    "codesearch index merge-scip",
  )
}
