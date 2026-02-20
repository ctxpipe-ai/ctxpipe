import { tool } from "langchain"
import { z } from "zod/v3"
import {
  codesearchBaseUrl,
  repositoryIdSchema,
  toToon,
} from "../lib/agentToolRuntime.js"

export const listFilesTool = tool(async ({ repositoryId, path }) => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ""
  const res = await fetch(`${codesearchBaseUrl()}/${repositoryId}/files${query}`)
  if (!res.ok) {
    throw new Error(`list_files failed with status ${res.status}`)
  }
  const payload = (await res.json()) as {
    entries: Array<{ name: string; path: string; type: "file" | "dir" }>
  }
  return toToon({
    repositoryId,
    path: path ?? "",
    entries: payload.entries,
  })
}, {
  name: "list_files",
  description: [
    "Tool: list_files",
    "- Purpose: Enumerate files/directories for a repository path.",
    "- Input: { repositoryId, path? } where path defaults to repository root.",
    "- repositoryId must use prefix repo_.",
    "- Output: TOON text with entries.",
  ].join("\n"),
  schema: z.object({
    repositoryId: repositoryIdSchema,
    path: z.string().optional(),
  }),
})
