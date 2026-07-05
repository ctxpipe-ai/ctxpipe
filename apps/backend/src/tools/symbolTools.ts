import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../auth/context.js"
import { repositoryIdSchema, toToon } from "../lib/agentToolRuntime.js"
import { getRepositoryForOrg } from "../models/repositories.js"
import {
  isZoektSearchClientFailure,
  zoektSearchRepository,
} from "./codesearchZoekt.js"
import { COMPACT_SEARCH_OPTS, compactSearchResponse } from "./zoektCompact.js"
import {
  buildSymbolDefinitionQuery,
  buildSymbolReferencesQuery,
} from "./zoektSymbolQuery.js"

const languageSchema = z
  .string()
  .min(1)
  .describe(
    "Programming language (e.g. TypeScript, Go, Python). Used for lang: filter.",
  )

export const findSymbolDefinitionsTool = tool(
  async ({ repositoryId, symbol, language }) => {
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
    const Q = buildSymbolDefinitionQuery(symbol, language)
    const searchResponse = await zoektSearchRepository(
      repository,
      Q,
      COMPACT_SEARCH_OPTS,
    )
    if (isZoektSearchClientFailure(searchResponse)) {
      return toToon({
        error: "search_client_error",
        kind: "symbol_definitions",
        repositoryId,
        status: searchResponse.status,
        detail: searchResponse.error,
      })
    }
    return toToon({
      kind: "symbol_definitions",
      note: "Uses Zoekt sym: index (ctags at index time). Empty hits may mean reindex after ctags or no symbol metadata.",
      repository: {
        id: repository.id,
        name: repository.name,
        zoektRepoId: repository.zoektRepoId,
      },
      symbol: symbol.trim(),
      language,
      query: Q,
      zoektOptsApplied: COMPACT_SEARCH_OPTS,
      ...compactSearchResponse(searchResponse),
    })
  },
  {
    name: "find_symbol_definitions",
    description: `Find likely declaration sites for a symbol using Zoekt's symbol index (sym:). Requires universal-ctags at index time.
Use when you know the symbol name and language—before scanning whole files with search or get_file.
Input: { repositoryId, symbol, language }.
References (uses) are not exact; use find_symbol_references for heuristic occurrences.`,
    schema: z.object({
      repositoryId: repositoryIdSchema,
      symbol: z
        .string()
        .min(1)
        .describe("Symbol name, e.g. class or function identifier"),
      language: languageSchema,
    }),
  },
)

export const findSymbolReferencesTool = tool(
  async ({ repositoryId, symbol, language }) => {
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
    const Q = buildSymbolReferencesQuery(symbol, language)
    const searchResponse = await zoektSearchRepository(
      repository,
      Q,
      COMPACT_SEARCH_OPTS,
    )
    if (isZoektSearchClientFailure(searchResponse)) {
      return toToon({
        error: "search_client_error",
        kind: "symbol_references",
        repositoryId,
        status: searchResponse.status,
        detail: searchResponse.error,
      })
    }
    return toToon({
      kind: "symbol_references",
      note: "Heuristic: word-boundary regexp on content—not compiler-accurate find-refs.",
      repository: {
        id: repository.id,
        name: repository.name,
        zoektRepoId: repository.zoektRepoId,
      },
      symbol: symbol.trim(),
      language,
      query: Q,
      zoektOptsApplied: COMPACT_SEARCH_OPTS,
      ...compactSearchResponse(searchResponse),
    })
  },
  {
    name: "find_symbol_references",
    description: `Find occurrences of a symbol name via case-sensitive word-boundary regexp (heuristic references, not IDE-accurate).
Use after definitions when you need more call sites. Input: { repositoryId, symbol, language }.`,
    schema: z.object({
      repositoryId: repositoryIdSchema,
      symbol: z.string().min(1),
      language: languageSchema,
    }),
  },
)
