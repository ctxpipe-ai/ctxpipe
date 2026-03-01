import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { cloneAndIndexRepository } from "../domain/indexing/service.js"
import {
  repoCachePath,
  resolveSafePath,
} from "../domain/repositories/paths.js"
import { resolveRepositoryRef } from "../domain/repositories/resolveRef.js"
import {
  getAccessibleRepository,
  getIndexableRepository,
} from "../domain/repositories/service.js"

const repoIdParam = z
  .string()
  .regex(/^repo_[a-z2-7]+$/)
  .openapi({ example: "repo_abc123" })

export const indexRoute = createRoute({
  method: "post",
  path: "/{repoId}/index",
  request: {
    params: z.object({ repoId: repoIdParam }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            message: z.string().optional(),
          }),
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

const resolveRefRequestSchema = z
  .object({
    branch: z.string().min(1).optional(),
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
  app.openapi(indexRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const indexable = await getIndexableRepository(db, repoId, auth.orgId)
    if (!indexable) {
      return c.json({ error: "Repository not found or access denied" }, 404)
    }
    try {
      await cloneAndIndexRepository({
        db,
        repoId: repo.id,
        repoGitUrl: repo.gitUrl,
        clonePath: repoCachePath(repo.orgId, repo.id),
        githubToken: c.get("env").GITHUB_TOKEN,
        zoektRepoId: indexable.zoektRepoId,
        repoName: indexable.name,
        repoUrl: indexable.gitUrl,
      })
      return c.json({ ok: true, message: "Repository cloned and indexed" }, 200)
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
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const basePath = repoCachePath(repo.orgId, repo.id)
    try {
      const dirPath = path ? resolveSafePath(basePath, path) : basePath
      const names = await readdir(dirPath)
      const entries: { name: string; path: string; type: "file" | "dir" }[] = []
      for (const name of names) {
        const fullPath = join(dirPath, name)
        const relPath = path ? `${path}/${name}` : name
        const s = await stat(fullPath)
        entries.push({
          name,
          path: relPath,
          type: s.isDirectory() ? "dir" : "file",
        })
      }
      return c.json({ entries }, 200)
    } catch {
      return c.json({ error: "Path not found" }, 404)
    }
  })

  app.openapi(resolveRefRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const { branch } = c.req.valid("json")
    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    try {
      const resolved = await resolveRepositoryRef({
        gitUrl: repo.gitUrl,
        branch,
        githubToken: c.get("env").GITHUB_TOKEN,
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
    let fullPath: string
    try {
      fullPath = resolveSafePath(repoCachePath(repo.orgId, repo.id), filePath)
    } catch {
      return c.json({ error: "Invalid file path" }, 404)
    }
    try {
      const file = Bun.file(fullPath)
      const exists = await file.exists()
      if (!exists) return c.json({ error: "File not found" }, 404)
      const arrayBuffer = await file.arrayBuffer()
      return new Response(arrayBuffer, {
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
    const basePath = repoCachePath(repo.orgId, repo.id)
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
