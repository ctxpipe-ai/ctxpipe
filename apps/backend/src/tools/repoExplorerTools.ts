import {
  graphCalleesTool,
  graphCallersTool,
  graphFindSymbolTool,
} from "./codegraphTools.js"
import { getFileTool } from "./getFile.js"
import { globFilesTool } from "./globFiles.js"
import { searchTool } from "./search.js"
import { structuralSearchTool } from "./structuralSearch.js"
import {
  findSymbolDefinitionsTool,
  findSymbolReferencesTool,
} from "./symbolTools.js"

/** Append to ingestion system prompts so models use sym: tools when appropriate. */
export const REPO_EXPLORER_TOOLS_HINT = `Choose the matching code tool: list_files maps repository paths; search and find_symbol_definitions use Zoekt for fast lexical and symbol discovery; find_symbol_references is heuristic text search. structural_search uses ast-grep for syntax-aware source patterns. graph_find_symbol, graph_get_callers, and graph_get_callees use SCIP for compiler/indexer-produced definitions and cross-file references; graph tools require symbol/file/module anchors. None of these tools searches org memory.`

/**
 * Shared tools for repo exploration (ingestion agents + conversation advisor).
 * Order: narrow listing → search → symbol helpers → structural search → graph → file read.
 *
 * Output size is bounded per tool (`glob_files` max entries, Zoekt compact caps,
 * `get_file` preview/full caps) and globally by `toToon` in `agentToolRuntime.ts`.
 */
export const standardRepoExplorerTools = [
  globFilesTool,
  searchTool,
  findSymbolDefinitionsTool,
  findSymbolReferencesTool,
  structuralSearchTool,
  graphFindSymbolTool,
  graphCallersTool,
  graphCalleesTool,
  getFileTool,
] as const
