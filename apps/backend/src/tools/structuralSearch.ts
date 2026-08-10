import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../auth/context.js"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import {
  codesearchBaseUrl,
  repositoryIdSchema,
  toToon,
} from "../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../lib/withTransientHttpRetry.js"
import { getRepositoryForOrg } from "../models/repositories.js"

export const structuralSearchTool = tool(
  async ({ repositoryId, pattern, lang, paths, globs, limit }) => {
    const repository = await getRepositoryForOrg(
      requireCurrentOrgId(),
      repositoryId,
    )
    if (!repository) {
      return toToon({
        error: "repository_not_found",
        repositoryId,
      })
    }

    const env = parseEnv(process.env as Record<string, string | undefined>)
    const token = await signUpstreamJwt({
      env,
      audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
      claims: {
        sub: `repo:${repository.id}`,
        orgId: repository.orgId,
        principal: "service",
      },
    })
    const res = await withTransientHttpRetry(
      async () =>
        fetch(`${codesearchBaseUrl()}/${repository.id}/structural-search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ pattern, lang, paths, globs, limit }),
        }),
      { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
    )

    if (res.status >= 400 && res.status < 500) {
      const detail = await res.text().catch(() => "")
      return toToon({
        error: "structural_search_client_error",
        repositoryId,
        status: res.status,
        detail: detail.trim() || `client_error_${res.status}`,
      })
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(
        `structural_search failed with status ${res.status}${detail ? `: ${detail}` : ""}`,
      )
    }

    return toToon(await res.json())
  },
  {
    name: "structural_search",
    description: `Search source syntax with ast-grep patterns in one repository.
Use for syntax-aware code shapes (for example, calls or declarations matching a pattern). Unlike search (Zoekt), this understands syntax; unlike graph_* (SCIP), it does not traverse cross-file symbol references.
Input: { repositoryId, pattern, lang?, paths?, globs?, limit? }. paths are repository-relative. globs may include exclusions such as "!**/*.test.ts".`,
    schema: z.object({
      repositoryId: repositoryIdSchema,
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
      limit: z.number().int().positive().max(1_000).optional().default(100),
    }),
  },
)
