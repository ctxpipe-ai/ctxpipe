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

const MAX_LIST_FILES_ENTRIES = 500
const DEFAULT_LIST_LIMIT = 100

export const listFilesTool = tool(
  async ({ repositoryId, path, limit, offset }) => {
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
    const query = path ? `?path=${encodeURIComponent(path)}` : ""
    const res = await withTransientHttpRetry(
      async () =>
        fetch(`${codesearchBaseUrl()}/${repositoryId}/files${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
    )
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        return toToon({
          error: "not_found",
          path: path ?? "",
          repositoryId,
          status: res.status,
        })
      }
      throw new Error(`list_files failed with status ${res.status}`)
    }
    const payload = (await res.json()) as {
      entries: Array<{ name: string; path: string; type: "file" | "dir" }>
    }
    const raw = payload.entries
    const truncatedGlobally = raw.length > MAX_LIST_FILES_ENTRIES
    const all = truncatedGlobally ? raw.slice(0, MAX_LIST_FILES_ENTRIES) : raw
    const off = Math.max(0, offset ?? 0)
    const lim = Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_FILES_ENTRIES)
    const page = all.slice(off, off + lim)
    const hasMore = off + page.length < all.length
    return toToon({
      repositoryId,
      path: path ?? "",
      entries: page,
      offset: off,
      limit: lim,
      totalEntries: all.length,
      hasMore,
      truncatedGlobally,
    })
  },
  {
    name: "list_files",
    description: [
      "List files/directories under a path (default limit 100).",
      "Input: { repositoryId, path?, limit?, offset? } — use a narrow path for large dirs.",
    ].join(" "),
    schema: z.object({
      repositoryId: repositoryIdSchema,
      path: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIST_FILES_ENTRIES).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
)
