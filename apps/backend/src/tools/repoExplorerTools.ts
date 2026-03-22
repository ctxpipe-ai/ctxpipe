import {
  findSymbolDefinitionsTool,
  findSymbolReferencesTool,
} from "./symbolTools.js"
import { getFileTool } from "./getFile.js"
import { listFilesTool } from "./listFiles.js"
import { searchTool } from "./search.js"

/** Append to ingestion system prompts so models use sym: tools when appropriate. */
export const REPO_EXPLORER_TOOLS_HINT = `Symbol tools: find_symbol_definitions (Zoekt sym:, requires ctags at index time) and find_symbol_references (word-boundary regexp, heuristic). When you know a symbol name and language, prefer them before broad search or large file reads.`

/**
 * Shared tools for repo exploration (ingestion agents + conversation advisor).
 * Order: narrow listing → search → symbol helpers → file read.
 */
export const standardRepoExplorerTools = [
  listFilesTool,
  searchTool,
  findSymbolDefinitionsTool,
  findSymbolReferencesTool,
  getFileTool,
] as const
