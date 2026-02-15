import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import type { AppEnv } from "../app/env.js"
import { REPO_CACHE_DIR } from "../config/paths.js"
import { repositories } from "../db/schema.js"

const MOCK_ORG_ID = "org_mock123"

const repoIdParam = z
  .string()
  .regex(/^repo_[A-Z2-7]+$/)
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

async function getRepoAndCheckAccess(
  db: NonNullable<AppEnv["Variables"]["db"]>,
  repoId: string,
): Promise<{ id: string; orgId: string; gitUrl: string } | null> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .limit(1)
  if (!row || row.orgId !== MOCK_ORG_ID) return null
  return { id: row.id, orgId: row.orgId, gitUrl: row.gitUrl }
}

function repoCachePath(orgId: string, repoId: string): string {
  return `${REPO_CACHE_DIR}/${orgId}/${repoId}`
}

export function registerRepoRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(indexRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const { repoId } = c.req.valid("param")
    const repo = await getRepoAndCheckAccess(db, repoId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const clonePath = repoCachePath(repo.orgId, repo.id)
    // TODO: clone repo (with GITHUB_TOKEN if GitHub URL), then run zoekt-git-index
    // For now return ok; full implementation will clone and index
    return c.json(
      {
        ok: true,
        message: "Index triggered (clone+index not yet implemented)",
      },
      200,
    )
  })

  app.openapi(listFilesRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const { repoId } = c.req.valid("param")
    const path = c.req.valid("query").path
    const repo = await getRepoAndCheckAccess(db, repoId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const basePath = repoCachePath(repo.orgId, repo.id)
    const dirPath = path ? join(basePath, path) : basePath
    try {
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

  app.openapi(getFileRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const { repoId, path: filePath } = c.req.valid("param")
    const repo = await getRepoAndCheckAccess(db, repoId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const fullPath = `${repoCachePath(repo.orgId, repo.id)}/${filePath}`
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
    const { repoId } = c.req.valid("param")
    const { paths } = c.req.valid("json")
    const repo = await getRepoAndCheckAccess(db, repoId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)
    const basePath = repoCachePath(repo.orgId, repo.id)
    const result: Record<string, string> = {}
    for (const p of paths) {
      try {
        const file = Bun.file(`${basePath}/${p}`)
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
