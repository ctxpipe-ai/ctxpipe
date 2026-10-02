import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { checkoutKeyFromAuth, indexCheckoutFromAuth } from "../auth/jwt.js"
import { isTransientDbConnectionError } from "../db/transient.js"
import { withRepositoryIndexOperation } from "../domain/indexing/indexConcurrency.js"
import {
  releaseIndexPipelineReference,
  releaseIndexPipelineReservation,
  tryAcquireIndexPipeline,
} from "../domain/indexing/indexPipelineAdmission.js"
import { userFacingIndexingError } from "../domain/indexing/memoryFitError.js"
import {
  type IndexPhaseRepoContext,
  phaseCloneCheckout,
  phaseDetectLanguages,
  phaseMarkCheckoutIndexed,
  phaseMergeScip,
  phaseScipLanguage,
  phaseZoekt,
} from "../domain/indexing/phases.js"
import {
  repoCheckoutPath,
  scipIndexPath,
} from "../domain/repositories/paths.js"
import {
  getAccessibleRepository,
  getIndexableRepository,
} from "../domain/repositories/service.js"
import { zoektRepositoryName } from "../domain/zoekt/shardPrefix.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../observability/logger.js"
import {
  repositoryNotFoundBody,
  repositoryNotFoundResponse,
} from "./errorBody.js"

const repoIdParam = z
  .string()
  .regex(/^repo_[a-z2-7]+$/)
  .openapi({ example: "repo_abc123" })

function isGitRefOrShaSafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}

const optionalGitRefOrSha = z
  .string()
  .min(1)
  .max(256)
  .refine(isGitRefOrShaSafe, { message: "invalid characters in ref or hash" })

const renameSchema = z.object({
  from: z.string(),
  to: z.string(),
})

const cloneCheckoutRequestSchema = z
  .object({
    githubToken: z.string().min(1).optional(),
    targetHash: optionalGitRefOrSha.optional(),
    fromHash: optionalGitRefOrSha.optional(),
    checkoutKey: z.string().min(1).max(128).optional(),
  })
  .default({})
  .openapi("IndexCloneCheckoutRequest")

const cloneCheckoutResponseSchema = z
  .object({
    ok: z.literal(true),
    targetHash: z.string(),
    ingestMode: z.enum(["full", "partial"]),
    changedPaths: z.array(z.string()),
    deletedPaths: z.array(z.string()),
    renames: z.array(renameSchema),
  })
  .openapi("IndexCloneCheckoutResponse")

const okResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("IndexPhaseOkResponse")

const mergeScipResponseSchema = z
  .object({
    ok: z.literal(true),
    shardCount: z.number().int().nonnegative(),
  })
  .openapi("IndexMergeScipResponse")

const detectLanguagesRequestSchema = z
  .object({
    ingestMode: z.enum(["full", "partial"]),
    changedPaths: z.array(z.string()).default([]),
    deletedPaths: z.array(z.string()).default([]),
    renames: z.array(renameSchema).default([]),
  })
  .openapi("IndexDetectLanguagesRequest")

const detectLanguagesResponseSchema = z
  .object({
    ok: z.literal(true),
    detectedLanguages: z.array(z.string()),
    languagesToIndex: z.array(z.string()),
  })
  .openapi("IndexDetectLanguagesResponse")

const scipLangResponseSchema = z
  .object({
    ok: z.literal(true),
    /** Public-facing note when the shard is incomplete (some projects failed). */
    issue: z.string().optional(),
  })
  .openapi("IndexScipLangResponse")

const scipLangAcceptedSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("running"),
  })
  .openapi("IndexScipLangAccepted")

const scipLangStatusSchema = z
  .object({
    status: z.enum(["running", "succeeded", "failed"]),
    issue: z.string().optional(),
    error: z.string().optional(),
  })
  .openapi("IndexScipLangStatus")

const scipLangRequestSchema = z
  .object({
    detectedLanguages: z.array(z.string()).min(1),
  })
  .openapi("IndexScipLangRequest")

const mergeScipRequestSchema = z
  .object({
    detectedLanguages: z.array(z.string()),
    languagesToMerge: z.array(z.string()).optional(),
  })
  .openapi("IndexMergeScipRequest")

const cloneCheckoutRoute = createRoute({
  method: "post",
  path: "/{repoId}/index/clone-checkout",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: { "application/json": { schema: cloneCheckoutRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: cloneCheckoutResponseSchema },
      },
      description: "Clone, checkout, and compute ingest diff",
    },
    403: { description: "Checkout does not match authenticated workspace" },
    404: repositoryNotFoundResponse,
    429: { description: "Index pipeline capacity exceeded" },
    503: { description: "Database not available" },
    500: { description: "Clone/checkout failed" },
  },
})

const zoektRoute = createRoute({
  method: "post",
  path: "/{repoId}/index/zoekt",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": {
          schema: z.object({}).default({}).openapi("IndexZoektRequest"),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: okResponseSchema } },
      description: "Zoekt index built",
    },
    404: repositoryNotFoundResponse,
    429: { description: "Index pipeline capacity exceeded" },
    503: { description: "Database not available" },
    500: { description: "Zoekt indexing failed" },
  },
})

const detectLanguagesRoute = createRoute({
  method: "post",
  path: "/{repoId}/index/detect-languages",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": { schema: detectLanguagesRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: detectLanguagesResponseSchema },
      },
      description: "Languages detected for SCIP indexing",
    },
    404: repositoryNotFoundResponse,
    429: { description: "Index pipeline capacity exceeded" },
    503: { description: "Database not available" },
    500: { description: "Language detection failed" },
  },
})

const scipLangRoute = createRoute({
  method: "post",
  path: "/{repoId}/index/scip/{lang}",
  request: {
    params: z.object({
      repoId: repoIdParam,
      lang: z.string().min(1).max(64),
    }),
    body: {
      content: { "application/json": { schema: scipLangRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: scipLangResponseSchema } },
      description: "Per-language SCIP shard built",
    },
    202: {
      content: { "application/json": { schema: scipLangAcceptedSchema } },
      description:
        "SCIP language phase accepted; read it back until it settles",
    },
    404: repositoryNotFoundResponse,
    429: { description: "Index pipeline capacity exceeded" },
    503: { description: "Database not available" },
    500: { description: "SCIP indexing failed" },
  },
})

const scipLangStatusRoute = createRoute({
  method: "get",
  path: "/{repoId}/index/scip/{lang}",
  request: {
    params: z.object({
      repoId: repoIdParam,
      lang: z.string().min(1).max(64),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: scipLangStatusSchema } },
      description: "In-flight or settled SCIP language phase",
    },
    404: { description: "SCIP language phase has not been started" },
  },
})

const mergeScipRoute = createRoute({
  method: "post",
  path: "/{repoId}/index/merge-scip",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: { "application/json": { schema: mergeScipRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: mergeScipResponseSchema } },
      description: "SCIP shards merged",
    },
    404: repositoryNotFoundResponse,
    429: { description: "Index pipeline capacity exceeded" },
    503: { description: "Database not available" },
    500: { description: "SCIP merge failed" },
  },
})

async function resolvePhaseContext(
  db: NonNullable<AppEnv["Variables"]["db"]>,
  orgId: string,
  repoId: string,
  options: { checkoutKey: string; githubToken?: string },
): Promise<
  | { ok: true; ctx: IndexPhaseRepoContext }
  | { ok: false; status: 503; error: string }
  | { ok: false; body: typeof repositoryNotFoundBody }
> {
  let repo: Awaited<ReturnType<typeof getAccessibleRepository>>
  try {
    repo = await getAccessibleRepository(db, repoId, orgId)
  } catch (error) {
    if (isTransientDbConnectionError(error)) {
      return { ok: false, status: 503, error: "Database connection lost" }
    }
    throw error
  }
  if (!repo) {
    return { ok: false, body: repositoryNotFoundBody }
  }
  const checkoutKey = options.checkoutKey
  let indexable: Awaited<ReturnType<typeof getIndexableRepository>>
  try {
    indexable = await getIndexableRepository(db, repoId, orgId, checkoutKey)
  } catch (error) {
    if (isTransientDbConnectionError(error)) {
      return { ok: false, status: 503, error: "Database connection lost" }
    }
    throw error
  }
  if (!indexable) {
    return { ok: false, body: repositoryNotFoundBody }
  }
  return {
    ok: true,
    ctx: {
      db,
      orgId: repo.orgId,
      repoId: repo.id,
      repoGitUrl: repo.gitUrl,
      checkoutKey,
      clonePath: repoCheckoutPath(repo.orgId, repo.id, checkoutKey),
      scipIndexPath: scipIndexPath(repo.orgId, repo.id, checkoutKey),
      zoektRepoId: indexable.zoektRepoId,
      zoektName: zoektRepositoryName({
        orgId: repo.orgId,
        repoId: repo.id,
        checkoutKey,
      }),
      repoName: indexable.name,
      repoUrl: indexable.gitUrl,
      githubToken: options.githubToken,
    },
  }
}
type PhaseContextFailure =
  | { ok: false; status: 503; error: string }
  | { ok: false; body: typeof repositoryNotFoundBody }

function phaseContextErrorResponse(
  c: { json: (body: unknown, status: 404 | 503) => Response },
  resolved: PhaseContextFailure,
): Response {
  if ("error" in resolved) {
    return c.json({ error: resolved.error }, resolved.status)
  }
  return c.json(resolved.body, 404)
}

async function withIndexPipelineAdmission(
  c: {
    json: (body: { error: string }, status: 429) => Response
  },
  repoId: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  const acquired = tryAcquireIndexPipeline(repoId)
  if (!acquired.ok) {
    return c.json({ error: "Index pipeline capacity exceeded" }, 429)
  }
  try {
    return await fn()
  } finally {
    releaseIndexPipelineReference(repoId)
  }
}

type ScipPhaseRun =
  | { status: "running" }
  | { status: "succeeded"; issue?: string }
  | { status: "failed"; error: string }

const scipPhaseRuns = new Map<string, ScipPhaseRun>()

/** A Workspace revision indexes into its own checkout, so it is part of the key. */
function scipPhaseKey(
  repoId: string,
  checkoutKey: string,
  lang: string,
): string {
  return `${repoId}:${checkoutKey}:${lang}`
}

export function resetScipPhaseRunsForTests(): void {
  scipPhaseRuns.clear()
}

async function runDetachedScipPhase(input: {
  key: string
  repoId: string
  lang: string
  ctx: IndexPhaseRepoContext
  detectedLanguages: string[]
}): Promise<void> {
  try {
    const result = await withRepositoryIndexOperation(input.repoId, () =>
      withLogger(
        createLogger({
          repositoryId: input.ctx.repoId,
          phase: `scip:${input.lang}`,
        }),
        () =>
          phaseScipLanguage(input.ctx, {
            language: input.lang,
            detectedLanguages: input.detectedLanguages,
          }),
      ),
    )
    const issue = result?.issue
    scipPhaseRuns.set(input.key, {
      status: "succeeded",
      ...(issue ? { issue } : {}),
    })
  } catch (error) {
    scipPhaseRuns.set(input.key, {
      status: "failed",
      error: userFacingIndexingError(error, "SCIP indexing failed"),
    })
  } finally {
    releaseIndexPipelineReference(input.repoId)
  }
}

async function finishIndexPipelineAdmission(
  repoId: string,
  responsePromise: Promise<Response>,
  reservation: "end-on-error" | "end",
): Promise<Response> {
  try {
    const response = await responsePromise
    if (reservation === "end" || response.status !== 200) {
      releaseIndexPipelineReservation(repoId)
    }
    return response
  } catch (error) {
    releaseIndexPipelineReservation(repoId)
    throw error
  }
}

export function registerIndexPhaseRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(cloneCheckoutRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    const checkoutKey = indexCheckoutFromAuth(auth, repoId, body.targetHash)
    if (body.checkoutKey && body.checkoutKey !== checkoutKey) {
      return c.json(
        { error: "Checkout does not match authenticated workspace" },
        403,
      )
    }
    return finishIndexPipelineAdmission(
      repoId,
      withIndexPipelineAdmission(c, repoId, () =>
        withRepositoryIndexOperation(repoId, async () => {
          const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
            githubToken: body.githubToken,
            checkoutKey,
          })
          if (!resolved.ok) {
            return phaseContextErrorResponse(c, resolved)
          }
          try {
            const result = await withLogger(
              createLogger({
                repositoryId: resolved.ctx.repoId,
                phase: "clone-checkout",
              }),
              async () => {
                getLogger().set({
                  step: "codesearch.index.phase.http",
                  phase: "clone-checkout",
                })
                getLogger().info("codesearch index phase clone-checkout")
                flushWorkflowLog()
                return phaseCloneCheckout(resolved.ctx, {
                  targetHash: body.targetHash,
                  fromHash: body.fromHash,
                })
              },
            )
            return c.json({ ok: true as const, ...result }, 200)
          } catch (error) {
            if (isTransientDbConnectionError(error)) {
              return c.json({ error: "Database connection lost" }, 503)
            }
            const message = userFacingIndexingError(
              error,
              "Clone/checkout failed",
            )
            return c.json({ error: message }, 500)
          }
        }),
      ),
      "end-on-error",
    )
  })

  app.openapi(zoektRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    return withIndexPipelineAdmission(c, repoId, () =>
      withRepositoryIndexOperation(repoId, async () => {
        const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
          checkoutKey: checkoutKeyFromAuth(auth, repoId),
        })
        if (!resolved.ok) {
          return phaseContextErrorResponse(c, resolved)
        }
        try {
          await withLogger(
            createLogger({ repositoryId: resolved.ctx.repoId, phase: "zoekt" }),
            async () => {
              getLogger().set({
                step: "codesearch.index.phase.http",
                phase: "zoekt",
              })
              getLogger().info("codesearch index phase zoekt")
              flushWorkflowLog()
              await phaseZoekt(resolved.ctx)
            },
          )
          return c.json({ ok: true as const }, 200)
        } catch (error) {
          if (isTransientDbConnectionError(error)) {
            return c.json({ error: "Database connection lost" }, 503)
          }
          const message = userFacingIndexingError(
            error,
            "Zoekt indexing failed",
          )
          return c.json({ error: message }, 500)
        }
      }),
    )
  })

  app.openapi(detectLanguagesRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    return finishIndexPipelineAdmission(
      repoId,
      withIndexPipelineAdmission(c, repoId, () =>
        withRepositoryIndexOperation(repoId, async () => {
          const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
            checkoutKey: checkoutKeyFromAuth(auth, repoId),
          })
          if (!resolved.ok) {
            return phaseContextErrorResponse(c, resolved)
          }
          try {
            const result = await withLogger(
              createLogger({
                repositoryId: resolved.ctx.repoId,
                phase: "detect-languages",
              }),
              () =>
                phaseDetectLanguages(resolved.ctx, {
                  ingestMode: body.ingestMode,
                  changedPaths: body.changedPaths,
                  deletedPaths: body.deletedPaths,
                  renames: body.renames,
                }),
            )
            return c.json({ ok: true as const, ...result }, 200)
          } catch (error) {
            if (isTransientDbConnectionError(error)) {
              return c.json({ error: "Database connection lost" }, 503)
            }
            const message = userFacingIndexingError(
              error,
              "Language detection failed",
            )
            return c.json({ error: message }, 500)
          }
        }),
      ),
      "end-on-error",
    )
  })

  app.openapi(scipLangRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId, lang } = c.req.valid("param")
    const body = c.req.valid("json")
    const checkoutKey = checkoutKeyFromAuth(auth, repoId)
    const key = scipPhaseKey(repoId, checkoutKey, lang)
    if (scipPhaseRuns.get(key)?.status === "running") {
      return c.json({ ok: true as const, status: "running" as const }, 202)
    }
    const acquired = tryAcquireIndexPipeline(repoId)
    if (!acquired.ok) {
      return c.json({ error: "Index pipeline capacity exceeded" }, 429)
    }
    scipPhaseRuns.set(key, { status: "running" })
    const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
      checkoutKey,
    })
    if (!resolved.ok) {
      scipPhaseRuns.delete(key)
      releaseIndexPipelineReference(repoId)
      return phaseContextErrorResponse(c, resolved)
    }
    void runDetachedScipPhase({
      key,
      repoId,
      lang,
      ctx: resolved.ctx,
      detectedLanguages: body.detectedLanguages,
    })
    return c.json({ ok: true as const, status: "running" as const }, 202)
  })

  app.openapi(scipLangStatusRoute, async (c) => {
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId, lang } = c.req.valid("param")
    const run = scipPhaseRuns.get(
      scipPhaseKey(repoId, checkoutKeyFromAuth(auth, repoId), lang),
    )
    if (!run) {
      return c.json({ error: "SCIP index has not been started" }, 404)
    }
    if (run.status === "failed") {
      return c.json({ status: "failed" as const, error: run.error }, 200)
    }
    if (run.status === "succeeded") {
      return c.json(
        {
          status: "succeeded" as const,
          ...(run.issue ? { issue: run.issue } : {}),
        },
        200,
      )
    }
    return c.json({ status: "running" as const }, 200)
  })

  app.openapi(mergeScipRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    return finishIndexPipelineAdmission(
      repoId,
      withIndexPipelineAdmission(c, repoId, () =>
        withRepositoryIndexOperation(repoId, async () => {
          const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
            checkoutKey: checkoutKeyFromAuth(auth, repoId),
          })
          if (!resolved.ok) {
            return phaseContextErrorResponse(c, resolved)
          }
          try {
            let shardCount = 0
            await withLogger(
              createLogger({
                repositoryId: resolved.ctx.repoId,
                phase: "merge-scip",
              }),
              async () => {
                try {
                  const published = await phaseMergeScip(resolved.ctx, {
                    detectedLanguages: body.detectedLanguages,
                    languagesToMerge: body.languagesToMerge,
                  })
                  shardCount = published.shardCount
                } finally {
                  await phaseMarkCheckoutIndexed(resolved.ctx)
                }
              },
            )
            return c.json({ ok: true as const, shardCount }, 200)
          } catch (error) {
            if (isTransientDbConnectionError(error)) {
              return c.json({ error: "Database connection lost" }, 503)
            }
            const message = userFacingIndexingError(error, "SCIP merge failed")
            return c.json({ error: message }, 500)
          }
        }),
      ),
      "end",
    )
  })
}
