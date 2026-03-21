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

const MAX_GET_FILE_CHARS = 96_000

export const getFileTool = tool(
  async ({ repositoryId, path, startLine, endLine, maxChars }) => {
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
    const res = await fetch(
      `${codesearchBaseUrl()}/${repositoryId}/files-query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ paths: [path] }),
      },
    )
    if (!res.ok) {
      throw new Error(`get_file failed with status ${res.status}`)
    }
    const payload = (await res.json()) as Record<string, string>
    const encoded = payload[path]
    if (!encoded) {
      throw new Error(`file not found: ${path}`)
    }
    const content = Buffer.from(encoded, "base64").toString("utf-8")

    const max = maxChars ?? MAX_GET_FILE_CHARS
    let body: string
    let truncated = false
    let totalChars = content.length
    let lineMeta:
      | {
          startLine: number
          endLine: number
          totalLines: number
        }
      | undefined

    if (startLine != null || endLine != null) {
      const lines = content.split(/\r?\n/)
      const totalLines = lines.length === 0 ? 1 : lines.length
      const start = startLine != null ? Math.max(1, Math.floor(startLine)) : 1
      const end =
        endLine != null ? Math.min(totalLines, Math.floor(endLine)) : totalLines
      let sliceText: string
      if (start > totalLines) {
        sliceText = ""
        lineMeta = { startLine: start, endLine: end, totalLines }
      } else {
        const slice = lines.slice(start - 1, end)
        sliceText = slice.join("\n")
        lineMeta = {
          startLine: start,
          endLine: Math.min(end, start - 1 + slice.length),
          totalLines,
        }
      }
      if (sliceText.length <= max) {
        body = sliceText
        truncated = false
      } else {
        body = sliceText.slice(0, max)
        truncated = true
      }
    } else {
      if (content.length <= max) {
        body = content
        truncated = false
      } else {
        body = content.slice(0, max)
        truncated = true
      }
      totalChars = content.length
    }

    return toToon({
      repositoryId,
      path,
      content: body,
      truncated,
      totalChars,
      maxCharsApplied: max,
      ...(lineMeta && { lines: lineMeta }),
      hint: truncated
        ? "Content was truncated. Pass startLine/endLine (1-based) for a specific range, or pass maxChars for a larger slice (still capped)."
        : undefined,
    })
  },
  {
    name: "get_file",
    description: [
      "Tool: get_file",
      "- Purpose: Read one file from a repository.",
      "- Input: { repositoryId, path, startLine?, endLine?, maxChars? }.",
      "- repositoryId must use prefix repo_.",
      "- Optional startLine/endLine (1-based, inclusive) to read a slice of lines only.",
      "- Optional maxChars caps returned UTF-8 length (server applies a default cap if omitted).",
      "- Output: TOON text including file path and utf-8 content (possibly truncated).",
    ].join("\n"),
    schema: z.object({
      repositoryId: repositoryIdSchema,
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      maxChars: z.number().int().positive().max(2_000_000).optional(),
    }),
  },
)
