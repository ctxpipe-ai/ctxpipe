import {
  globCheckoutFiles,
  CodesearchCheckoutError,
  type GlobFilesResponse,
} from "../domain/codeIngestion/codesearchClient.js"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../auth/context.js"
import { repositoryIdSchema, toToon } from "../lib/agentToolRuntime.js"
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
    return globCheckoutPaths({
      repositoryId,
      orgId: repository.orgId,
      workspaceId,
      pattern,
      path,
      onlyFiles,
      dot,
      limit,
      offset,
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

export type CheckoutGlobRequest = {
  pattern: string
  path?: string
  onlyFiles?: boolean
  dot?: boolean
  limit?: number
  offset?: number
}

/** Glob and page an already authorized, optionally revision-bound checkout. */
export async function globCheckoutPaths({
  repositoryId,
  orgId,
  workspaceId,
  sha,
  legacy,
  pattern,
  path,
  onlyFiles,
  dot,
  limit,
  offset,
}: CheckoutGlobRequest & {
  repositoryId: string
  orgId: string
  workspaceId?: string
  sha?: string
  legacy?: true
}) {
  let payload: GlobFilesResponse
  try {
    payload = await globCheckoutFiles({
      repositoryId,
      orgId,
      workspaceId,
      sha,
      legacy,
      request: {
        pattern,
        path: path ?? "",
        onlyFiles: onlyFiles ?? false,
        dot: dot ?? true,
        limit: MAX_GLOB_FILES_ENTRIES,
      },
    })
  } catch (error) {
    if (
      error instanceof CodesearchCheckoutError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      return toToon({
        error: "glob_failed",
        path: path ?? "",
        pattern,
        repositoryId,
        status: error.status,
      })
    }
    throw error
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
}
