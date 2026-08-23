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

const MAX_GLOB_FILES_ENTRIES = 500
const DEFAULT_GLOB_LIMIT = 100

export const globFilesTool = tool(
  async ({
    repositoryId,
    pattern,
    path,
    onlyFiles,
    dot,
    limit,
    offset,
    workspaceId,
  }) => {
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
        ...(workspaceId ? { workspaceId } : {}),
      },
    })
    // Fetch up to the tool-wide cap, then page with offset/limit client-side
    // (codesearch /glob has no offset).
    const res = await withTransientHttpRetry(
      async () =>
        fetch(`${codesearchBaseUrl()}/${repositoryId}/glob`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            pattern,
            path: path ?? "",
            onlyFiles: onlyFiles ?? false,
            dot: dot ?? true,
            limit: MAX_GLOB_FILES_ENTRIES,
          }),
        }),
      { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
    )
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        return toToon({
          error: "glob_failed",
          path: path ?? "",
          pattern,
          repositoryId,
          status: res.status,
        })
      }
      throw new Error(`glob_files failed with status ${res.status}`)
    }
    const payload = (await res.json()) as {
      entries: Array<{ name: string; path: string; type: "file" | "dir" }>
      truncated: boolean
      matched: number
    }
    const all = payload.entries.slice(0, MAX_GLOB_FILES_ENTRIES)
    const truncatedGlobally = payload.truncated || payload.matched > all.length
    const off = Math.max(0, offset ?? 0)
    const lim = Math.min(limit ?? DEFAULT_GLOB_LIMIT, MAX_GLOB_FILES_ENTRIES)
    const page = all.slice(off, off + lim)
    const hasMore = off + page.length < all.length || truncatedGlobally
    return toToon({
      repositoryId,
      path: path ?? "",
      pattern,
      onlyFiles: onlyFiles ?? false,
      dot: dot ?? true,
      entries: page,
      offset: off,
      limit: lim,
      totalEntries: all.length,
      matched: payload.matched,
      hasMore,
      truncatedGlobally,
    })
  },
  {
    name: "glob_files",
    description: [
      "List or discover repository paths with a glob.",
      "Defaults: onlyFiles false (dirs included), dot true (dotpaths included).",
      'Single folder (like old list_files): pattern "*", path "src/foo"',
      "(returns files and subdirectories in that folder only; * does not cross /).",
      'Recursive discover: pattern "**/package.json" or "**/*.{ts,tsx}", path optional cwd.',
      "Pass onlyFiles true when you only want files.",
      'Prefer narrow patterns over "**/*". Use offset/limit when truncated.',
      "Input: { repositoryId, pattern, path?, onlyFiles?, dot?, limit?, offset? }.",
    ].join(" "),
    schema: z.object({
      repositoryId: repositoryIdSchema,
      pattern: z.string().min(1).max(512),
      path: z.string().optional(),
      onlyFiles: z.boolean().optional(),
      dot: z.boolean().optional(),
      limit: z.number().int().positive().max(MAX_GLOB_FILES_ENTRIES).optional(),
      offset: z.number().int().min(0).optional(),
      workspaceId: z.string().min(1).optional(),
    }),
  },
)
