import {
  graphCalleesTool,
  graphCallersTool,
  graphFindSymbolTool,
} from "./codegraphTools.js"
import { getFileTool } from "./getFile.js"
import { listFilesTool } from "./listFiles.js"
import { searchTool } from "./search.js"
import {
  findSymbolDefinitionsTool,
  findSymbolReferencesTool,
} from "./symbolTools.js"

/** Append to ingestion system prompts so models use sym: tools when appropriate. */
export const REPO_EXPLORER_TOOLS_HINT = `Discovery: use search (Zoekt) and list_files first unless the task is explicitly structural with anchors. Symbol tools: find_symbol_definitions (Zoekt sym:) and find_symbol_references (heuristic). Structural graph tools: graph_find_symbol, graph_get_callers, graph_get_callees (CGC/Kùzu) — require symbol/file/module anchors; not for grep or org memory.`

/**
 * Shared tools for repo exploration (ingestion agents + conversation advisor).
 * Order: narrow listing → search → symbol helpers → graph → file read.
 *
 * Output size is bounded per tool (`list_files` max entries, Zoekt compact caps,
 * `get_file` preview/full caps) and globally by `toToon` in `agentToolRuntime.ts`.
 */
export const standardRepoExplorerTools = [
  listFilesTool,
  searchTool,
  findSymbolDefinitionsTool,
  findSymbolReferencesTool,
  graphFindSymbolTool,
  graphCallersTool,
  graphCalleesTool,
  getFileTool,
] as const
