import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../app/env.js"
import { checkoutKeyFromAuth } from "../auth/jwt.js"
import {
  repoCheckoutPath,
  resolveSafePath,
} from "../domain/repositories/paths.js"
import { getAccessibleRepository } from "../domain/repositories/service.js"
import {
  resolveStructuralSearchPaths,
  runStructuralSearch,
} from "../domain/search/structuralSearch.js"

const structuralSearchRequestSchema = z
  .object({
    pattern: z.string().min(1).describe("ast-grep pattern to match"),
    lang: z
      .string()
      .min(1)
      .optional()
      .describe("Optional ast-grep language identifier"),
    paths: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Repository-relative files or directories to search"),
    globs: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Optional ast-grep include or exclude globs"),
    limit: z
      .number()
      .int()
      .positive()
      .max(1_000)
      .optional()
      .default(100)
      .describe("Maximum number of matches to return"),
  })
  .openapi("StructuralSearchRequest")

const structuralSearchMatchSchema = z.record(z.string(), z.unknown())

export const structuralSearchRoute = createRoute({
  method: "post",
  path: "/{repoId}/structural-search",
  request: {
    params: z.object({
      repoId: z
        .string()
        .regex(/^repo_[a-z2-7]+$/)
        .openapi({ example: "repo_abc123" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: structuralSearchRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            matches: z.array(structuralSearchMatchSchema),
          }),
        },
      },
      description: "Structural matches from ast-grep",
    },
    400: { description: "Invalid request or repository path" },
    401: { description: "Unauthorized" },
    404: { description: "Repository not found or access denied" },
    500: { description: "ast-grep execution failed" },
    503: { description: "Database not available" },
  },
})

export function registerStructuralSearchRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(structuralSearchRoute, async (c) => {
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

    const checkoutPath = repoCheckoutPath(
      repo.orgId,
      repo.id,
      checkoutKeyFromAuth(auth),
    )
    let resolvedSearchPaths: { checkoutPath: string; paths: string[] }
    try {
      const searchPaths = (body.paths?.length ? body.paths : ["."]).map(
        (path) => resolveSafePath(checkoutPath, path),
      )
      resolvedSearchPaths = await resolveStructuralSearchPaths(
        checkoutPath,
        searchPaths,
      )
    } catch {
      return c.json({ error: "Invalid repository path" }, 400)
    }

    try {
      const matches = await runStructuralSearch({
        checkoutPath: resolvedSearchPaths.checkoutPath,
        pattern: body.pattern,
        lang: body.lang,
        globs: body.globs,
        paths: resolvedSearchPaths.paths,
        limit: body.limit,
      })
      return c.json({ matches }, 200)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ast-grep execution failed"
      return c.json({ error: message }, 500)
    }
  })
}
