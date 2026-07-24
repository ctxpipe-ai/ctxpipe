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

/** Hard cap for any single read (UTF-8 chars). */
const MAX_GET_FILE_CHARS = 96_000

/** Default when mode is full and maxChars omitted (lower than historical 96k default). */
const DEFAULT_FULL_READ_CHARS = 32_000

const PREVIEW_MAX_LINES = 120
const PREVIEW_MAX_CHARS = 12_000

export const getFileTool = tool(
  async ({
    repositoryId,
    path,
    startLine,
    endLine,
    maxChars,
    mode = "preview",
  }) => {
    const repository = await getRepositoryForOrg(
      requireCurrentOrgId(),
      repositoryId,
    )
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
    const res = await withTransientHttpRetry(
      async () =>
        fetch(`${codesearchBaseUrl()}/${repositoryId}/files-query`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ paths: [path] }),
        }),
      { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
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
    const totalLines = content.length === 0 ? 1 : content.split(/\r?\n/).length
    const totalChars = content.length

    const effectiveMax = Math.min(
      maxChars ?? MAX_GET_FILE_CHARS,
      MAX_GET_FILE_CHARS,
    )

    let body: string
    let truncated = false
    let lineMeta:
      | {
          startLine: number
          endLine: number
          totalLines: number
        }
      | undefined
    let readMode: "preview" | "full" | "range" = "full"

    if (startLine != null || endLine != null) {
      readMode = "range"
      const lines = content.split(/\r?\n/)
      const tl = lines.length === 0 ? 1 : lines.length
      const start = startLine != null ? Math.max(1, Math.floor(startLine)) : 1
      const end = endLine != null ? Math.min(tl, Math.floor(endLine)) : tl
      let sliceText: string
      if (start > tl) {
        sliceText = ""
        lineMeta = { startLine: start, endLine: end, totalLines: tl }
      } else {
        const slice = lines.slice(start - 1, end)
        sliceText = slice.join("\n")
        lineMeta = {
          startLine: start,
          endLine: Math.min(end, start - 1 + slice.length),
          totalLines: tl,
        }
      }
      if (sliceText.length <= effectiveMax) {
        body = sliceText
        truncated = false
      } else {
        body = sliceText.slice(0, effectiveMax)
        truncated = true
      }
    } else if (mode === "preview") {
      readMode = "preview"
      const lines = content.split(/\r?\n/)
      const slice = lines.slice(0, PREVIEW_MAX_LINES)
      let previewText = slice.join("\n")
      if (previewText.length > PREVIEW_MAX_CHARS) {
        previewText = previewText.slice(0, PREVIEW_MAX_CHARS)
        truncated = true
      } else if (
        lines.length > PREVIEW_MAX_LINES ||
        totalChars > previewText.length
      ) {
        truncated = true
      }
      body = previewText
      lineMeta = {
        startLine: 1,
        endLine: Math.min(PREVIEW_MAX_LINES, lines.length),
        totalLines,
      }
    } else {
      const cap = maxChars ?? DEFAULT_FULL_READ_CHARS
      const max = Math.min(cap, MAX_GET_FILE_CHARS)
      if (content.length <= max) {
        body = content
        truncated = false
      } else {
        body = content.slice(0, max)
        truncated = true
      }
    }

    const maxCharsApplied =
      readMode === "range"
        ? effectiveMax
        : readMode === "preview"
          ? PREVIEW_MAX_CHARS
          : Math.min(maxChars ?? DEFAULT_FULL_READ_CHARS, MAX_GET_FILE_CHARS)

    return toToon({
      repositoryId,
      path,
      mode: readMode,
      content: body,
      truncated,
      totalChars,
      maxCharsApplied,
      ...(lineMeta && { lines: lineMeta }),
      hint:
        readMode === "preview"
          ? "Preview only. Pass startLine/endLine for a range, mode full for a larger slice (capped), or maxChars up to 96000."
          : truncated
            ? "Content was truncated. Pass startLine/endLine (1-based) for a specific range, or pass maxChars for a larger slice (still capped)."
            : undefined,
    })
  },
  {
    name: "get_file",
    description: [
      "Read one file from a repository.",
      "Input: { repositoryId, path, startLine?, endLine?, maxChars?, mode? }.",
      "mode: preview (default) = first ~120 lines / 12k chars + total line count; use startLine/endLine or mode full to read more.",
      "maxChars caps UTF-8 length (max 96000).",
    ].join(" "),
    schema: z.object({
      repositoryId: repositoryIdSchema,
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      maxChars: z.number().int().positive().max(MAX_GET_FILE_CHARS).optional(),
      mode: z.enum(["preview", "full"]).optional().default("preview"),
    }),
  },
)
