import { tool } from "langchain"
import { z } from "zod/v3"
import { repositoryIdSchema, toToon } from "../lib/agentToolRuntime.js"
import { getRepository } from "../models/repositories.js"
import {
  isZoektSearchClientFailure,
  zoektSearchRepository,
} from "./codesearchZoekt.js"
import {
  COMPACT_SEARCH_OPTS,
  compactSearchResponse,
  FULL_SEARCH_OPTS,
} from "./zoektCompact.js"

export const searchTool = tool(
  async ({ repositoryId, query, detail = "compact" }) => {
    const repository = await getRepository(repositoryId)
    if (!repository) {
      return toToon({
        error: "repository_not_found",
        repositoryId,
      })
    }
    const opts = detail === "full" ? FULL_SEARCH_OPTS : COMPACT_SEARCH_OPTS
    const searchResponse = await zoektSearchRepository(repository, query, opts)
    if (isZoektSearchClientFailure(searchResponse)) {
      return toToon({
        error: "search_client_error",
        repositoryId,
        status: searchResponse.status,
        detail: searchResponse.error,
      })
    }
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
Zoekt tips: use file:, lang:, sym:, content:; AND is space; "or" for alternation; phrase quotes.
For known symbol + language, prefer find_symbol_definitions or find_symbol_references.`,
    schema: z.object({
      repositoryId: repositoryIdSchema,
      query: z.string().min(1),
      detail: z.enum(["compact", "full"]).optional().default("compact"),
    }),
  },
)
