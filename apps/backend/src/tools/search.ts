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

/** Merged into Zoekt SearchOptions to bound JSON response size (see zoekt api.SearchOptions). */
const DEFAULT_SEARCH_OPTS: Record<string, unknown> = {
  ShardMaxMatchCount: 200,
  TotalMaxMatchCount: 800,
  MaxDocDisplayCount: 80,
  MaxMatchDisplayCount: 400,
}

export const searchTool = tool(
  async ({ repositoryId, query }) => {
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
    const res = await fetch(`${codesearchBaseUrl()}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        Q: query,
        RepoIDs: [repository.zoektRepoId],
        Opts: DEFAULT_SEARCH_OPTS,
      }),
    })
    if (!res.ok) {
      throw new Error(`search failed with status ${res.status}`)
    }
    const searchResponse = (await res.json()) as Record<string, unknown>
    return toToon({
      repository: {
        id: repository.id,
        name: repository.name,
        zoektRepoId: repository.zoektRepoId,
      },
      query,
      zoektOptsApplied: DEFAULT_SEARCH_OPTS,
      response: searchResponse,
    })
  },
  {
    name: "search",
    description: `Tool: search
- Purpose: Full-text code search in exactly one repository via Zoekt.
- Input: { repositoryId, query }.
- repositoryId must use prefix repo_.
- Query authoring guide (Zoekt):
  - AND is implicit when terms are separated by spaces.
  - Use "or" for alternation, with parentheses for grouping.
  - Use "-" to negate a term/filter (example: -lang:javascript).
  - Useful filters: file:, lang:, sym:, branch:, type:, case:.
  - Quote phrases with spaces (example: content:"index ready").
  - Prefer fielded filters to reduce noise (example: file:repositories.ts zoektRepoId).
  - file: filters path/name, content: filters text inside files, sym: searches symbol names.
  - Regex is supported; use regex:/.../ or content:/.../ for content patterns.
  - Keep queries precise: combine content + file/lang/symbol constraints.
  - If results are too broad: add file:/lang:/sym:, add phrase quotes, or add negations.
  - If no results: remove restrictive filters, simplify regex, or try a broader synonym term.
- Query examples:
  - plain term: AuthService
  - phrase in file: file:repositories.ts content:"index ready"
  - language + file filter: lang:typescript file:package.json dependencies
  - regex content: regex:/TODO\\(.*security.*\\)/
  - grouped boolean: ("indexReady" or "zoektRepoId") file:repositories.ts
  - negation: TODO -file:test -lang:markdown
  - symbol search: sym:"getRepository" lang:typescript
- Suggested search workflow:
  - Start with 1-2 core terms.
  - Add file:/lang:/sym: filters to narrow.
  - Use quoted phrases for exact multi-word concepts.
  - Use regex only when exact terms miss variants.
- Output: TOON text with repository metadata and raw search response (match counts capped server-side).`,
    schema: z.object({
      repositoryId: repositoryIdSchema,
      query: z.string().min(1),
    }),
  },
)
