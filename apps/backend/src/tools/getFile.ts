import { tool } from "langchain"
import { z } from "zod/v3"
import {
  codesearchBaseUrl,
  repositoryIdSchema,
  toToon,
} from "../lib/agentToolRuntime.js"

export const getFileTool = tool(async ({ repositoryId, path }) => {
  const res = await fetch(`${codesearchBaseUrl()}/${repositoryId}/files-query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [path] }),
  })
  if (!res.ok) {
    throw new Error(`get_file failed with status ${res.status}`)
  }
  const payload = (await res.json()) as Record<string, string>
  const encoded = payload[path]
  if (!encoded) {
    throw new Error(`file not found: ${path}`)
  }
  const content = Buffer.from(encoded, "base64").toString("utf-8")
  return toToon({
    repositoryId,
    path,
    content,
  })
}, {
  name: "get_file",
  description: [
    "Tool: get_file",
    "- Purpose: Read one file from a repository.",
    "- Input: { repositoryId, path }.",
    "- repositoryId must use prefix repo_.",
    "- Output: TOON text including file path and utf-8 content.",
  ].join("\n"),
  schema: z.object({
    repositoryId: repositoryIdSchema,
    path: z.string().min(1),
  }),
})
