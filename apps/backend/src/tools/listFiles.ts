import { tool } from "langchain"
import { z } from "zod/v3"
import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import {
  codesearchBaseUrl,
  repositoryIdSchema,
  toToon,
} from "../lib/agentToolRuntime.js"
import { getRepository } from "../models/repositories.js"

const MAX_LIST_FILES_ENTRIES = 500

export const listFilesTool = tool(
  async ({ repositoryId, path }) => {
    const repository = await getRepository(repositoryId)
    if (!repository) {
      throw new Error(`repository not found: ${repositoryId}`)
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
    const res = await fetch(
      `${codesearchBaseUrl()}/${repositoryId}/files${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) {
      throw new Error(`list_files failed with status ${res.status}`)
    }
    const payload = (await res.json()) as {
      entries: Array<{ name: string; path: string; type: "file" | "dir" }>
    }
    const all = payload.entries
    const truncated = all.length > MAX_LIST_FILES_ENTRIES
    const entries = truncated ? all.slice(0, MAX_LIST_FILES_ENTRIES) : all
    return toToon({
      repositoryId,
      path: path ?? "",
      entries,
      truncated,
      totalEntries: all.length,
      maxEntriesReturned: MAX_LIST_FILES_ENTRIES,
    })
  },
  {
    name: "list_files",
    description: [
      "Tool: list_files",
      "- Purpose: Enumerate files/directories for a repository path.",
      "- Input: { repositoryId, path? } where path defaults to repository root.",
      "- repositoryId must use prefix repo_.",
      "- Output: TOON text with entries (may truncate very large directories; narrow `path` if truncated).",
    ].join("\n"),
    schema: z.object({
      repositoryId: repositoryIdSchema,
      path: z.string().optional(),
    }),
  },
)
