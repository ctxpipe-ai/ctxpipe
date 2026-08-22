import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { checkoutKeyFromAuth } from "../auth/jwt.js"
import { isTransientDbConnectionError } from "../db/transient.js"
import { withRepositoryIndexOperation } from "../domain/indexing/indexConcurrency.js"
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

const scipLangRequestSchema = z
  .object({
    detectedLanguages: z.array(z.string()).min(1),
  })
  .openapi("IndexScipLangRequest")

const mergeScipRequestSchema = z
  .object({
    detectedLanguages: z.array(z.string()),
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
    404: { description: "Repository not found" },
    403: { description: "Checkout does not match authenticated workspace" },
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
    404: { description: "Repository not found" },
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
    404: { description: "Repository not found" },
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
      content: { "application/json": { schema: okResponseSchema } },
      description: "Per-language SCIP shard built",
    },
    404: { description: "Repository not found" },
    503: { description: "Database not available" },
    500: { description: "SCIP indexing failed" },
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
      content: { "application/json": { schema: okResponseSchema } },
      description: "SCIP shards merged",
    },
    404: { description: "Repository not found" },
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
  | { ok: false; status: 404 | 503; error: string }
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
    return {
      ok: false,
      status: 404,
      error: "Repository not found or access denied",
    }
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
    return {
      ok: false,
      status: 404,
      error: "Repository not found or access denied",
    }
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
export function registerIndexPhaseRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(cloneCheckoutRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    const checkoutKey = checkoutKeyFromAuth(auth)
    if (body.checkoutKey && body.checkoutKey !== checkoutKey) {
      return c.json(
        { error: "Checkout does not match authenticated workspace" },
        403,
      )
    }
    return withRepositoryIndexOperation(repoId, async () => {
      const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
        githubToken: body.githubToken,
        checkoutKey,
      })
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status)
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
        const message = userFacingIndexingError(error, "Clone/checkout failed")
        return c.json({ error: message }, 500)
      }
    })
  })

  app.openapi(zoektRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    return withRepositoryIndexOperation(repoId, async () => {
      const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
        checkoutKey: checkoutKeyFromAuth(auth),
      })
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status)
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
        const message = userFacingIndexingError(error, "Zoekt indexing failed")
        return c.json({ error: message }, 500)
      }
    })
  })

  app.openapi(detectLanguagesRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    return withRepositoryIndexOperation(repoId, async () => {
      const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
        checkoutKey: checkoutKeyFromAuth(auth),
      })
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status)
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
    })
  })

  app.openapi(scipLangRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId, lang } = c.req.valid("param")
    const body = c.req.valid("json")
    return withRepositoryIndexOperation(repoId, async () => {
      const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
        checkoutKey: checkoutKeyFromAuth(auth),
      })
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status)
      }
      try {
        await withLogger(
          createLogger({
            repositoryId: resolved.ctx.repoId,
            phase: `scip:${lang}`,
          }),
          () =>
            phaseScipLanguage(resolved.ctx, {
              language: lang,
              detectedLanguages: body.detectedLanguages,
            }),
        )
        return c.json({ ok: true as const }, 200)
      } catch (error) {
        if (isTransientDbConnectionError(error)) {
          return c.json({ error: "Database connection lost" }, 503)
        }
        const message = userFacingIndexingError(error, "SCIP indexing failed")
        return c.json({ error: message }, 500)
      }
    })
  })

  app.openapi(mergeScipRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    return withRepositoryIndexOperation(repoId, async () => {
      const resolved = await resolvePhaseContext(db, auth.orgId, repoId, {
        checkoutKey: checkoutKeyFromAuth(auth),
      })
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status)
      }
      try {
        await withLogger(
          createLogger({
            repositoryId: resolved.ctx.repoId,
            phase: "merge-scip",
          }),
          async () => {
            await phaseMergeScip(resolved.ctx, {
              detectedLanguages: body.detectedLanguages,
            })
            await phaseMarkCheckoutIndexed(resolved.ctx)
          },
        )
        return c.json({ ok: true as const }, 200)
      } catch (error) {
        if (isTransientDbConnectionError(error)) {
          return c.json({ error: "Database connection lost" }, 503)
        }
        const message = userFacingIndexingError(error, "SCIP merge failed")
        return c.json({ error: message }, 500)
      }
    })
  })
}
