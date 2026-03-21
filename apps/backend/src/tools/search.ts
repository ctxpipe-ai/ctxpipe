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

/** Default Zoekt caps for full/raw responses. */
const FULL_SEARCH_OPTS: Record<string, unknown> = {
  ShardMaxMatchCount: 200,
  TotalMaxMatchCount: 800,
  MaxDocDisplayCount: 80,
  MaxMatchDisplayCount: 400,
}

/** Tighter caps when returning compact matches only. */
const COMPACT_SEARCH_OPTS: Record<string, unknown> = {
  ShardMaxMatchCount: 80,
  TotalMaxMatchCount: 200,
  MaxDocDisplayCount: 40,
  MaxMatchDisplayCount: 120,
}

const COMPACT_MAX_MATCHES = 80
const COMPACT_SNIPPET_CHARS = 220

type ZoektLineMatch = {
  LineNumber?: number
  Line?: string
  Preview?: string
}

type ZoektFileMatch = {
  FileName?: string
  LineMatches?: ZoektLineMatch[]
}

function getZoektFiles(raw: Record<string, unknown>): ZoektFileMatch[] {
  const direct = raw.Files
  if (Array.isArray(direct)) return direct as ZoektFileMatch[]
  const result = raw.Result as Record<string, unknown> | undefined
  const nested = result?.Files
  if (Array.isArray(nested)) return nested as ZoektFileMatch[]
  return []
}

function decodeZoektLine(line: string | undefined): string {
  if (!line) return ""
  try {
    return Buffer.from(line, "base64").toString("utf-8")
  } catch {
    return line
  }
}

function compactSearchResponse(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const files = getZoektFiles(raw)
  const matches: Array<{
    path: string
    line?: number
    snippet: string
  }> = []
  for (const f of files) {
    const path = f.FileName ?? ""
    const lines = Array.isArray(f.LineMatches) ? f.LineMatches : []
    for (const lm of lines) {
      if (matches.length >= COMPACT_MAX_MATCHES) break
      const rawLine = lm.Line ?? lm.Preview
      const decoded = decodeZoektLine(rawLine).slice(0, COMPACT_SNIPPET_CHARS)
      matches.push({
        path,
        line: typeof lm.LineNumber === "number" ? lm.LineNumber : undefined,
        snippet: decoded,
      })
    }
    if (matches.length >= COMPACT_MAX_MATCHES) break
  }
  return {
    format: "compact",
    matchCount: matches.length,
    truncated: matches.length >= COMPACT_MAX_MATCHES,
    matches,
  }
}

export const searchTool = tool(
  async ({ repositoryId, query, detail = "compact" }) => {
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
    const opts = detail === "full" ? FULL_SEARCH_OPTS : COMPACT_SEARCH_OPTS
    const res = await fetch(`${codesearchBaseUrl()}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        Q: query,
        RepoIDs: [repository.zoektRepoId],
        Opts: opts,
      }),
    })
    if (!res.ok) {
      throw new Error(`search failed with status ${res.status}`)
    }
    const searchResponse = (await res.json()) as Record<string, unknown>
    if (detail === "full") {
      return toToon({
        repository: {
          id: repository.id,
          name: repository.name,
          zoektRepoId: repository.zoektRepoId,
        },
        query,
        zoektOptsApplied: opts,
        response: searchResponse,
      })
    }
    return toToon({
      repository: {
        id: repository.id,
        name: repository.name,
        zoektRepoId: repository.zoektRepoId,
      },
      query,
      zoektOptsApplied: opts,
      ...compactSearchResponse(searchResponse),
    })
  },
  {
    name: "search",
    description: `Zoekt full-text search in one repository.
Input: { repositoryId, query, detail? } — repositoryId prefix repo_.
detail: "compact" (default): paths + short snippets only. "full": raw Zoekt JSON (large).
Zoekt tips: use file:, lang:, sym:, content:; AND is space; "or" for alternation; phrase quotes.`,
    schema: z.object({
      repositoryId: repositoryIdSchema,
      query: z.string().min(1),
      detail: z.enum(["compact", "full"]).optional().default("compact"),
    }),
  },
)
