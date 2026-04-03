import type { OpenAPIHono } from "@hono/zod-openapi"
import { createRoute, z } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import type { AppEnv } from "../app/env.js"
import { repositoryCheckouts } from "../db/schema.js"
import { executeCgcGraphQuery } from "../domain/graph/executeGraphPrimitive.js"
import {
  DEFAULT_CHECKOUT_KEY,
  kuzuDbPath,
  repoCheckoutPath,
  resolveSafePath,
} from "../domain/repositories/paths.js"
import { getAccessibleRepository } from "../domain/repositories/service.js"

const graphPrimitiveSchema = z.enum([
  "find_symbol",
  "get_callers",
  "get_callees",
  "get_imports",
  "get_type_hierarchy",
  "get_containing_scope",
  "trace_path",
])

const graphRequestSchema = z
  .object({
    primitive: graphPrimitiveSchema,
    checkoutKey: z.string().min(1).optional().default(DEFAULT_CHECKOUT_KEY),
    symbol: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    maxDepth: z.number().int().positive().max(10).optional(),
    limit: z.number().int().positive().max(200).optional(),
    endSymbol: z.string().min(1).optional(),
  })
  .openapi("GraphRequest")

export const graphRoute = createRoute({
  method: "post",
  path: "/{repoId}/graph",
  request: {
    params: z.object({
      repoId: z
        .string()
        .regex(/^repo_[a-z2-7]+$/)
        .openapi({ example: "repo_abc123" }),
    }),
    body: {
      content: { "application/json": { schema: graphRequestSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            primitive: graphPrimitiveSchema,
            results: z.array(z.record(z.string(), z.unknown())),
            note: z.string().optional(),
          }),
        },
      },
      description: "Canonical graph response (CodeGraphContext / Kùzu)",
    },
    400: { description: "Bad request" },
    401: { description: "Unauthorized" },
    404: { description: "Repository or checkout not found" },
    503: { description: "Service unavailable (e.g. database not configured)" },
  },
})

export function registerGraphRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(graphRoute, async (c) => {
    const db = c.get("db")
    if (!db) return c.json({ error: "Database not configured" }, 503)
    const auth = c.get("auth")
    if (!auth) throw new Error("Missing auth context")
    const { repoId } = c.req.valid("param")
    const body = c.req.valid("json")

    const hasAnchor = Boolean(body.symbol ?? body.filePath ?? body.module)
    if (body.primitive !== "find_symbol" && !hasAnchor) {
      return c.json(
        {
          error: "This primitive requires a symbol, filePath, or module anchor",
        },
        400,
      )
    }
    if (
      body.primitive === "find_symbol" &&
      !body.symbol &&
      !body.filePath &&
      !body.module
    ) {
      return c.json(
        {
          error:
            "find_symbol requires at least one of symbol, filePath, or module",
        },
        400,
      )
    }
    if (body.primitive === "trace_path" && (!body.symbol || !body.filePath)) {
      return c.json(
        { error: "trace_path requires symbol and filePath anchors" },
        400,
      )
    }
    if (
      body.primitive === "get_containing_scope" &&
      (!body.symbol || !body.filePath)
    ) {
      return c.json(
        { error: "get_containing_scope requires symbol and filePath anchors" },
        400,
      )
    }

    const repo = await getAccessibleRepository(db, repoId, auth.orgId)
    if (!repo)
      return c.json({ error: "Repository not found or access denied" }, 404)

    const [checkout] = await db
      .select({ id: repositoryCheckouts.id })
      .from(repositoryCheckouts)
      .where(
        and(
          eq(repositoryCheckouts.repositoryId, repoId),
          eq(repositoryCheckouts.checkoutKey, body.checkoutKey),
        ),
      )
      .limit(1)

    if (!checkout) {
      return c.json({ error: "Checkout not found" }, 404)
    }

    const checkoutPath = repoCheckoutPath(repo.orgId, repo.id, body.checkoutKey)
    const graphDbPath = kuzuDbPath(repo.orgId, repo.id, body.checkoutKey)
    const resolvedFilePath = body.filePath
      ? resolveSafePath(checkoutPath, body.filePath)
      : undefined

    const result = await executeCgcGraphQuery({
      primitive: body.primitive,
      kuzuDbPath: graphDbPath,
      repoPath: checkoutPath,
      symbol: body.symbol,
      filePath: resolvedFilePath,
      module: body.module,
      maxDepth: body.maxDepth,
      limit: body.limit,
      endSymbol: body.endSymbol,
    })

    const notes: string[] = []
    if (result.note) notes.push(result.note)
    if (!result.ok && result.error) {
      notes.push(result.error)
    }
    if (result.stderr) {
      notes.push(`stderr: ${result.stderr}`)
    }

    return c.json({
      ok: true,
      primitive: body.primitive,
      results: result.results,
      ...(notes.length > 0 ? { note: notes.join(" | ") } : {}),
    })
  })
}
