import { realpath } from "node:fs/promises"
import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { checkoutKeyFromAuth, indexCheckoutFromAuth } from "../auth/jwt.js"
import {
  tryWithRepositoryPurgeOperation,
  withRepositoryPurgeOperation,
} from "../domain/indexing/indexConcurrency.js"
import { cloneAndIndexRepository } from "../domain/indexing/service.js"
import {
  COLLECTABLE_CHECKOUT_KEY,
  deleteCheckoutFromDisk,
  sweepRepositoryDisk,
} from "../domain/repositories/checkoutGc.js"
import {
  GlobInvalidRequestError,
  GlobPathNotFoundError,
  globFilesInCheckout,
  listCheckoutFilePaths,
} from "../domain/repositories/globFiles.js"
import {
  DEFAULT_CHECKOUT_KEY,
  readContainedDirectory,
  readContainedFile,
  repoCheckoutPath,
  resolveContainedRealPath,
  scipIndexPath,
} from "../domain/repositories/paths.js"
import { purgeRepositoryFromDisk } from "../domain/repositories/purge.js"
import { resolveRepositoryRef } from "../domain/repositories/resolveRef.js"
import {
  getAccessibleRepository,
  getIndexableRepository,
  listCheckoutKeys,
} from "../domain/repositories/service.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../observability/logger.js"
import { repositoryGitRemote } from "../utils/git.js"
import {
  repositoryNotFoundBody,
  repositoryNotFoundResponse,
  repositoryOrPathNotFoundResponse,
} from "./errorBody.js"
import { registerIndexPhaseRoutes } from "./indexPhases.js"
import { plainGitRemoteSchema } from "./plainGitRemoteSchema.js"

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

/** Refs and SHAs: bounded length, no ASCII control characters. */
const optionalGitRefOrSha = z
  .string()
  .min(1)
  .max(256)
  .refine(isGitRefOrShaSafe, { message: "invalid characters in ref or hash" })

const indexRequestSchema = z
  .object({
    githubToken: z.string().min(1).optional(),
    /** The checked plain git remote of a repository with no token (CTX-815). */
    plainGit: plainGitRemoteSchema.optional(),
    /** Commit SHA or ref to index. If omitted, the remote default branch is resolved. */
    targetHash: optionalGitRefOrSha.optional(),
    /** Previous indexed commit for partial-ingestion metadata (diff + ancestor check). */
    fromHash: optionalGitRefOrSha.optional(),
  })
  .default({})
  .openapi("IndexRequest")

const purgeRequestSchema = z
  .object({
    zoektRepoId: z.number().int().positive(),
    /** Required for service principal when the repository row is already gone. */
    repoName: z.string().min(1).optional(),
  })
  .openapi("PurgeRepositoryRequest")

const purgeResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("PurgeRepositoryResponse")

const indexResponseSchema = z
  .object({
    ok: z.literal(true),
    targetHash: z.string(),
    ingestMode: z.enum(["full", "partial"]),
    changedPaths: z.array(z.string()),
    deletedPaths: z
      .array(z.string())
      .describe(
        "Deleted paths; includes source paths of renames/copies (R/C) from git name-status.",
      ),
    renames: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
      }),
    ),
    message: z.string().optional(),
  })
  .openapi("IndexResponse")

const indexRoute = createRoute({
  method: "post",
  path: "/{repoId}/index",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": {
          schema: indexRequestSchema,
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: indexResponseSchema,
        },
      },
      description: "Index triggered",
    },
    404: repositoryNotFoundResponse,
    403: { description: "Access denied" },
    503: { description: "Database not available" },
    500: { description: "Indexing failed" },
  },
})

const purgeRepositoryRoute = createRoute({
  method: "post",
  path: "/{repoId}/purge",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": {
          schema: purgeRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: purgeResponseSchema,
        },
      },
      description: "Disk and index data removed for the repository",
    },
    400: { description: "Invalid request" },
    404: repositoryNotFoundResponse,
    403: { description: "Access denied" },
  },
})

const deleteCheckoutsRequestSchema = z
  .object({
    /** `rev:<sha>`, `ws:<workspaceId>:<sha>`, or `ws:<workspaceId>` keys; never `default`. */
    checkoutKeys: z
      .array(z.string().regex(COLLECTABLE_CHECKOUT_KEY))
      .min(1)
      .max(10),
    /**
     * The database time before the backend found that no other running run
     * uses these keys; the ingestion run that used them ended. Then only a
     * row that a run used after this time keeps the files, not each row
     * that changed in the last hour.
     */
    runEndedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .openapi("DeleteCheckoutsRequest")

const deleteCheckoutsResponseSchema = z
  .object({
    deleted: z.array(z.object({ checkoutKey: z.string() })),
    skipped: z.array(
      z.object({
        checkoutKey: z.string(),
        reason: z.enum(["published", "not_found", "recent"]),
      }),
    ),
  })
  .openapi("DeleteCheckoutsResponse")

const deleteCheckoutsRoute = createRoute({
  method: "post",
  path: "/{repoId}/checkouts/delete",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": { schema: deleteCheckoutsRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: deleteCheckoutsResponseSchema },
      },
      description:
        "Clones, SCIP files, and Zoekt shards of the listed checkouts removed. The caller deletes the checkout rows of `deleted`.",
    },
    403: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "The token is not a collection token for this repository",
    },
    404: repositoryNotFoundResponse,
    409: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description:
        "An index job of the repository runs now. Nothing was deleted; try again later.",
    },
    503: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Database not available",
    },
  },
})

const sweepCheckoutsResponseSchema = z
  .object({
    deletedEntries: z.number(),
    deletedBytes: z.number(),
    /** The published checkout has no directory: index it again. */
    publishedMissing: z.boolean(),
  })
  .openapi("SweepCheckoutsResponse")

const sweepCheckoutsRoute = createRoute({
  method: "post",
  path: "/{repoId}/checkouts/sweep",
  request: { params: z.object({ repoId: repoIdParam }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: sweepCheckoutsResponseSchema },
      },
      description:
        "Checkout directories, SCIP files, Zoekt shards, and temporary files with no checkout row and older than one hour removed",
    },
    403: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "The token is not a collection token for this repository",
    },
    404: repositoryNotFoundResponse,
    409: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description:
        "An index job of the repository runs now. Nothing was deleted; try again later.",
    },
    503: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Database not available",
    },
  },
})

const listFilesRoute = createRoute({
  method: "get",
  path: "/{repoId}/files",
  request: {
    params: z.object({ repoId: repoIdParam }),
    query: z.object({
      path: z.string().optional().default(""),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(
              z.object({
                name: z.string(),
                path: z.string(),
                type: z.enum(["file", "dir"]),
              }),
            ),
          }),
        },
      },
      description: "List of file entries",
    },
    404: repositoryOrPathNotFoundResponse,
    403: { description: "Access denied" },
  },
})

const globRequestSchema = z
  .object({
    pattern: z.string().min(1).max(512),
    path: z.string().optional().default(""),
    onlyFiles: z.boolean().optional().default(false),
    dot: z.boolean().optional().default(true),
    limit: z.number().int().positive().max(50_000).optional(),
  })
  .openapi("GlobFilesRequest")

const globResponseSchema = z
  .object({
    entries: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        type: z.enum(["file", "dir"]),
      }),
    ),
    truncated: z.boolean(),
    matched: z.number().int().nonnegative(),
  })
  .openapi("GlobFilesResponse")

const listTreeRoute = createRoute({
  method: "get",
  path: "/{repoId}/tree",
  request: {
    params: z.object({ repoId: repoIdParam }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            paths: z.array(z.string()),
          }),
        },
      },
      description: "File paths under the repository checkout on disk",
    },
    404: { description: "Checkout not found" },
    403: { description: "Access denied" },
    500: { description: "Tree listing failed" },
  },
})

const globFilesRoute = createRoute({
  method: "post",
  path: "/{repoId}/glob",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": {
          schema: globRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: globResponseSchema,
        },
      },
      description: "Glob matches under the repository checkout",
    },
    400: { description: "Invalid path or glob pattern" },
    404: repositoryOrPathNotFoundResponse,
    403: { description: "Access denied" },
    500: { description: "Glob scan failed" },
  },
})

const resolveRefRequestSchema = z
  .object({
    branch: z.string().min(1).optional(),
    githubToken: z.string().min(1).optional(),
    /** The checked plain git remote of a repository with no token (CTX-815). */
    plainGit: plainGitRemoteSchema.optional(),
  })
  .openapi("ResolveRefRequest")

const resolveRefRoute = createRoute({
  method: "post",
  path: "/{repoId}/resolve-ref",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": {
          schema: resolveRefRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            branch: z.string(),
            hash: z.string(),
          }),
        },
      },
      description: "Resolved branch and commit hash",
    },
    404: repositoryNotFoundResponse,
    403: { description: "Access denied" },
    500: { description: "Ref resolution failed" },
  },
})

const getFileRoute = createRoute({
  method: "get",
  path: "/{repoId}/files/{path}",
  request: {
    params: z.object({
      repoId: repoIdParam,
      path: z.string().describe("File path within repo"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/octet-stream": {
          schema: z.string(),
          description: "File contents",
        },
        "text/plain": { schema: z.string(), description: "Text file" },
      },
      description: "File content",
    },
    404: repositoryOrPathNotFoundResponse,
    403: { description: "Access denied" },
  },
})

const filesQueryRequestSchema = z
  .object({
    paths: z.array(z.string()).min(1),
    /**
     * A folder of the checkout. When set, `paths` are relative to it and a
     * read never leaves it, also through a symlink.
     */
    root: z
      .string()
      .max(300)
      .refine(
        (root) =>
          !root.startsWith("/") &&
          !root.includes("\\") &&
          root
            .split("/")
            .every((segment) => segment && segment !== "." && segment !== ".."),
        "The root must be a relative folder path",
      )
      .optional(),
    /**
     * A size limit in bytes. A file larger than the limit is not read: its
     * entry has only its size.
     */
    maxBytes: z.number().int().positive().optional(),
  })
  .openapi("FilesQueryRequest")

const filesQueryRoute = createRoute({
  method: "post",
  path: "/{repoId}/files-query",
  request: {
    params: z.object({ repoId: repoIdParam }),
    body: {
      content: {
        "application/json": {
          schema: filesQueryRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.record(
            z.string(),
            z.union([
              z.string(),
              z
                .object({ size: z.number().int(), tooLarge: z.literal(true) })
                .openapi("TooLargeFile"),
            ]),
          ),
          description:
            "Map of path to base64-encoded content, or to the size only when the file is larger than `maxBytes`",
        },
      },
      description: "Files by path",
    },
    404: repositoryNotFoundResponse,
    403: { description: "Access denied" },
  },
})

export function registerRepoRoutes(app: OpenAPIHono<AppEnv>) {
  // Durable OpenWorkflow phase endpoints (clone-checkout / zoekt / scip / …).
  // Registered before the monolithic POST /{repoId}/index composer.
  registerIndexPhaseRoutes(app)

  app.openapi(purgeRepositoryRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    if (body.zoektRepoId <= 0) {
      return c.json({ error: "Invalid zoektRepoId" }, 400)
    }
    return withRepositoryPurgeOperation(repoId, async () => {
      const repo = await getAccessibleRepository(db, repoId, auth.orgId)
      if (repo) {
        await purgeRepositoryFromDisk({
          orgId: repo.orgId,
          repoId: repo.id,
          repoName: repo.name,
          zoektRepoId: body.zoektRepoId,
        })
        return c.json({ ok: true as const }, 200)
      }
      // After Postgres delete commits, the row is gone. Service callers may still
      // purge disk/shards using JWT orgId + body identity (not user-spoofable).
      // Bind path repoId to JWT sub minted as `repo-purge:{repositoryId}`.
      if (
        auth.principal === "service" &&
        body.repoName &&
        auth.sub === `repo-purge:${repoId}`
      ) {
        await purgeRepositoryFromDisk({
          orgId: auth.orgId,
          repoId,
          repoName: body.repoName,
          zoektRepoId: body.zoektRepoId,
        })
        return c.json({ ok: true as const }, 200)
      }
      return c.json(repositoryNotFoundBody, 404)
    })
  })

  app.openapi(deleteCheckoutsRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    if (auth.principal !== "service" || auth.sub !== `repo-gc:${repoId}`)
      return c.json({ error: "Access denied" }, 403)
    const { checkoutKeys, runEndedAt } = c.req.valid("json")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) return c.json(repositoryNotFoundBody, 404)
    const result = await tryWithRepositoryPurgeOperation(repoId, async () => {
      const deleted: Array<{ checkoutKey: string }> = []
      const skipped: Array<{
        checkoutKey: string
        reason: "published" | "not_found" | "recent"
      }> = []
      for (const checkoutKey of new Set(checkoutKeys)) {
        if (checkoutKey === repo.publishedCheckoutKey) {
          skipped.push({ checkoutKey, reason: "published" })
          continue
        }
        const row = await getIndexableRepository(
          db,
          repoId,
          auth.orgId,
          checkoutKey,
        )
        if (!row) {
          skipped.push({ checkoutKey, reason: "not_found" })
          continue
        }
        // A run took the key again after the caller listed it. The index
        // operation of that run waits for this lock, so the row is read
        // under the lock.
        if (
          runEndedAt
            ? (row.checkoutUsedAt?.getTime() ?? Number.POSITIVE_INFINITY) >
              Date.parse(runEndedAt)
            : row.checkoutUsedRecently
        ) {
          skipped.push({ checkoutKey, reason: "recent" })
          continue
        }
        await deleteCheckoutFromDisk({
          orgId: repo.orgId,
          repoId: repo.id,
          checkoutKey,
          zoektRepoId: row.zoektRepoId,
        })
        deleted.push({ checkoutKey })
      }
      return { deleted, skipped }
    })
    if (!result.acquired)
      return c.json(
        { error: "An index job of this repository runs now; try again later" },
        409,
      )
    getLogger().set({
      step: "codesearch.checkout_gc",
      repoId,
      deletedKeys: result.value.deleted.length,
      skippedKeys: result.value.skipped.length,
    })
    return c.json(result.value, 200)
  })

  app.openapi(sweepCheckoutsRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    if (auth.principal !== "service" || auth.sub !== `repo-gc:${repoId}`)
      return c.json({ error: "Access denied" }, 403)
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) return c.json(repositoryNotFoundBody, 404)
    const result = await tryWithRepositoryPurgeOperation(repoId, async () =>
      sweepRepositoryDisk({
        orgId: repo.orgId,
        repoId: repo.id,
        // Read under the purge operation: a new run adds its row before it
        // indexes, and its index operation waits for this one.
        rowKeys: await listCheckoutKeys(db, repoId, auth.orgId),
        publishedCheckoutKey: repo.publishedCheckoutKey ?? DEFAULT_CHECKOUT_KEY,
        minAgeMs: 60 * 60 * 1000,
      }),
    )
    if (!result.acquired)
      return c.json(
        { error: "An index job of this repository runs now; try again later" },
        409,
      )
    getLogger().set({
      step: "codesearch.checkout_sweep",
      repoId,
      deletedEntries: result.value.deletedEntries,
      deletedBytes: result.value.deletedBytes,
      publishedMissing: result.value.publishedMissing,
    })
    return c.json(result.value, 200)
  })

  app.openapi(indexRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    const checkoutKey = indexCheckoutFromAuth(auth, repoId, body.targetHash)
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) return c.json(repositoryNotFoundBody, 404)
    const indexable = await getIndexableRepository(
      db,
      repoId,
      auth.orgId,
      checkoutKey,
    )
    if (!indexable) {
      return c.json(repositoryNotFoundBody, 404)
    }

    const startMs = Date.now()
    const baseContext = {
      repositoryId: repo.id,
      repoName: indexable.name,
      zoektRepoId: indexable.zoektRepoId,
      targetHash: body.targetHash ?? null,
    }

    try {
      const result = await withLogger(createLogger(baseContext), async () => {
        const logger = getLogger()
        logger.set({ step: "codesearch.index.http.start", ...baseContext })
        logger.info("codesearch index http start")
        flushWorkflowLog()

        try {
          const indexResult = await cloneAndIndexRepository({
            db,
            orgId: repo.orgId,
            repoId: repo.id,
            repoGitUrl: repo.gitUrl,
            checkoutKey,
            clonePath: repoCheckoutPath(repo.orgId, repo.id, checkoutKey),
            scipIndexPath: scipIndexPath(repo.orgId, repo.id, checkoutKey),
            githubToken: body.githubToken,
            plainGit: body.plainGit,
            zoektRepoId: indexable.zoektRepoId,
            repoName: indexable.name,
            repoUrl: indexable.gitUrl,
            targetHash: body.targetHash,
            fromHash: body.fromHash,
          })

          const endLogger = getLogger()
          endLogger.set({
            step: "codesearch.index.http.end",
            ...baseContext,
            durationMs: Date.now() - startMs,
            ingestMode: indexResult.ingestMode,
            changedPathCount: indexResult.changedPaths.length,
            deletedPathCount: indexResult.deletedPaths.length,
            renameCount: indexResult.renames.length,
            targetHash: indexResult.targetHash,
          })
          endLogger.info("codesearch index http end")
          flushWorkflowLog()

          return indexResult
        } catch (error) {
          const endLogger = getLogger()
          endLogger.set({
            step: "codesearch.index.http.end",
            durationMs: Date.now() - startMs,
            error: error instanceof Error ? error.message : String(error),
            ...baseContext,
          })
          endLogger.info("codesearch index http end error")
          flushWorkflowLog()
          throw error
        }
      })

      return c.json(
        {
          ok: true as const,
          targetHash: result.targetHash,
          ingestMode: result.ingestMode,
          changedPaths: result.changedPaths,
          deletedPaths: result.deletedPaths,
          renames: result.renames,
          message: "Repository cloned and indexed",
        },
        200,
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Clone/index execution failed"
      return c.json({ error: message }, 500)
    }
  })

  app.openapi(listFilesRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const path = c.req.valid("query").path
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) {
      return c.json(repositoryNotFoundBody, 404)
    }
    const basePath = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth, repoId, repo.publishedCheckoutKey),
    )
    let dirents: Awaited<ReturnType<typeof readContainedDirectory>>
    try {
      const dirPath = await resolveContainedRealPath(basePath, path ?? ".")
      dirents = await readContainedDirectory(await realpath(basePath), dirPath)
    } catch {
      return c.json({ error: "Path not found" }, 404)
    }
    const entries = dirents
      .filter((dirent) => !dirent.isSymbolicLink())
      .map((dirent) => ({
        name: dirent.name,
        path: path ? `${path}/${dirent.name}` : dirent.name,
        type: dirent.isDirectory() ? ("dir" as const) : ("file" as const),
      }))
    return c.json({ entries }, 200)
  })

  app.openapi(listTreeRoute, async (c) => {
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    let publishedCheckoutKey: string | undefined
    if (!auth.repositoryRevisions) {
      const db = c.get("db")
      if (!db) return c.json({ error: "Database not configured" }, 503)
      const repository = await getAccessibleRepository(db, repoId, auth.orgId)
      if (!repository)
        return c.json({ error: "Repository not found or access denied" }, 404)
      publishedCheckoutKey = repository.publishedCheckoutKey
    }
    const checkoutRoot = repoCheckoutPath(
      auth.orgId,
      repoId,
      checkoutKeyFromAuth(auth, repoId, publishedCheckoutKey),
    )
    try {
      const paths = await listCheckoutFilePaths(checkoutRoot)
      return c.json({ paths }, 200)
    } catch (error) {
      if (error instanceof GlobPathNotFoundError) {
        return c.json({ error: error.message }, 404)
      }
      // The error text holds absolute cache paths, so only the log gets it.
      c.get("log").error(error instanceof Error ? error : String(error))
      return c.json({ error: "Tree listing failed" }, 500)
    }
  })

  app.openapi(globFilesRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) {
      return c.json(repositoryNotFoundBody, 404)
    }
    const checkoutRoot = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth, repoId, repo.publishedCheckoutKey),
    )
    try {
      const result = await globFilesInCheckout({
        checkoutRoot,
        pattern: body.pattern,
        path: body.path,
        onlyFiles: body.onlyFiles,
        dot: body.dot,
        limit: body.limit,
      })
      return c.json(result, 200)
    } catch (error) {
      if (error instanceof GlobPathNotFoundError) {
        return c.json({ error: error.message }, 404)
      }
      if (error instanceof GlobInvalidRequestError) {
        return c.json({ error: error.message }, 400)
      }
      // The error text holds absolute cache paths, so only the log gets it.
      c.get("log").error(error instanceof Error ? error : String(error))
      return c.json({ error: "Glob scan failed" }, 500)
    }
  })

  app.openapi(resolveRefRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const { branch, githubToken, plainGit } = c.req.valid("json")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) return c.json(repositoryNotFoundBody, 404)
    try {
      const resolved = await resolveRepositoryRef({
        remote: repositoryGitRemote({
          gitUrl: repo.gitUrl,
          githubToken,
          plainGit,
        }),
        branch,
      })
      return c.json(resolved, 200)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Ref resolution failed"
      return c.json({ error: message }, 500)
    }
  })

  app.openapi(getFileRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId, path: filePath } = c.req.valid("param")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) return c.json(repositoryNotFoundBody, 404)
    const basePath = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth, repoId, repo.publishedCheckoutKey),
    )
    let data: Awaited<ReturnType<typeof readContainedFile>>
    try {
      data = await readContainedFile(basePath, filePath)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Path traversal is not allowed"
      ) {
        return c.json({ error: "Invalid file path" }, 404)
      }
      return c.json({ error: "File not found" }, 404)
    }
    return new Response(data, {
      headers: { "Content-Type": "application/octet-stream" },
    })
  })

  app.openapi(filesQueryRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const { paths, root, maxBytes } = c.req.valid("json")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo) return c.json(repositoryNotFoundBody, 404)
    const basePath = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth, repoId, repo.publishedCheckoutKey),
    )
    const result: Record<string, string | { size: number; tooLarge: true }> = {}
    for (const p of paths) {
      try {
        const data =
          maxBytes === undefined
            ? await readContainedFile(basePath, p, root)
            : await readContainedFile(basePath, p, root ?? "", maxBytes)
        result[p] = Buffer.isBuffer(data) ? data.toString("base64") : data
      } catch {
        // omit missing files
      }
    }
    return c.json(result, 200)
  })
}
