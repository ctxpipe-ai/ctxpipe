import { lstat, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { checkoutKeyFromAuth } from "../auth/jwt.js"
import { withRepositoryPurgeOperation } from "../domain/indexing/indexConcurrency.js"
import { cloneAndIndexRepository } from "../domain/indexing/service.js"
import {
  GlobInvalidRequestError,
  GlobPathNotFoundError,
  globFilesInCheckout,
} from "../domain/repositories/globFiles.js"
import {
  repoCheckoutPath,
  resolveSafePath,
  resolveSafeReadableFilePath,
  scipIndexPath,
} from "../domain/repositories/paths.js"
import { purgeRepositoryFromDisk } from "../domain/repositories/purge.js"
import { resolveRepositoryRef } from "../domain/repositories/resolveRef.js"
import {
  getAccessibleRepository,
  getIndexableRepository,
} from "../domain/repositories/service.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../observability/logger.js"
import { registerIndexPhaseRoutes } from "./indexPhases.js"

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

export const indexRoute = createRoute({
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
    404: { description: "Repository not found" },
    403: { description: "Access denied" },
    503: { description: "Database not available" },
    500: { description: "Indexing failed" },
  },
})

export const purgeRepositoryRoute = createRoute({
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
    404: { description: "Repository not found" },
    403: { description: "Access denied" },
  },
})

export const listFilesRoute = createRoute({
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
    404: { description: "Repository not found" },
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

export const globFilesRoute = createRoute({
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
    404: { description: "Repository or path not found" },
    403: { description: "Access denied" },
    500: { description: "Glob scan failed" },
  },
})

const resolveRefRequestSchema = z
  .object({
    branch: z.string().min(1).optional(),
    githubToken: z.string().min(1).optional(),
  })
  .openapi("ResolveRefRequest")

export const resolveRefRoute = createRoute({
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
    404: { description: "Repository not found" },
    403: { description: "Access denied" },
    500: { description: "Ref resolution failed" },
  },
})

export const getFileRoute = createRoute({
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
    404: { description: "Repository or file not found" },
    403: { description: "Access denied" },
  },
})

const filesQueryRequestSchema = z
  .object({
    paths: z.array(z.string()).min(1),
  })
  .openapi("FilesQueryRequest")

export const filesQueryRoute = createRoute({
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
          schema: z.record(z.string(), z.string()),
          description: "Map of path to base64-encoded content",
        },
      },
      description: "Files by path",
    },
    404: { description: "Repository not found" },
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
      return c.json({ error: "Repository not found or access denied" }, 404)
    })
  })

  app.openapi(indexRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")
    const checkoutKey = checkoutKeyFromAuth(auth)
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const indexable = await getIndexableRepository(
      db,
      repoId,
      auth.orgId,
      checkoutKey,
    )
    if (!indexable) {
      return c.json({ error: "Repository not found or access denied" }, 404)
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
      return c.json({ error: "Repository not found or access denied" }, 404)
    }
    const basePath = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth),
    )
    let dirPath: string
    let names: string[]
    try {
      dirPath = path ? resolveSafePath(basePath, path) : basePath
      names = await readdir(dirPath)
    } catch {
      return c.json({ error: "Path not found" }, 404)
    }
    const entries: { name: string; path: string; type: "file" | "dir" }[] = []
    for (const name of names) {
      const fullPath = join(dirPath, name)
      const relPath = path ? `${path}/${name}` : name
      const s = await lstat(fullPath)
      if (s.isSymbolicLink()) continue
      entries.push({
        name,
        path: relPath,
        type: s.isDirectory() ? "dir" : "file",
      })
    }
    return c.json({ entries }, 200)
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
      return c.json({ error: "Repository not found or access denied" }, 404)
    }
    const checkoutRoot = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth),
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
      const message =
        error instanceof Error ? error.message : "Glob scan failed"
      return c.json({ error: message }, 500)
    }
  })

  app.openapi(resolveRefRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const { branch, githubToken } = c.req.valid("json")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    try {
      const resolved = await resolveRepositoryRef({
        gitUrl: repo.gitUrl,
        branch,
        githubToken,
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
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const basePath = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth),
    )
    let fullPath: string
    try {
      fullPath = await resolveSafeReadableFilePath(basePath, filePath)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Path traversal is not allowed"
      ) {
        return c.json({ error: "Invalid file path" }, 404)
      }
      return c.json({ error: "File not found" }, 404)
    }
    try {
      const data = await readFile(fullPath)
      return new Response(data, {
        headers: { "Content-Type": "application/octet-stream" },
      })
    } catch {
      return c.json({ error: "File not found" }, 404)
    }
  })

  app.openapi(filesQueryRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const { paths } = c.req.valid("json")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const basePath = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth),
    )
    const result: Record<string, string> = {}
    for (const p of paths) {
      try {
        const fullPath = resolveSafePath(basePath, p)
        const file = Bun.file(fullPath)
        if (await file.exists()) {
          const buf = await file.arrayBuffer()
          result[p] = btoa(String.fromCharCode(...new Uint8Array(buf)))
        }
      } catch {
        // omit missing files
      }
    }
    return c.json(result, 200)
  })
}
