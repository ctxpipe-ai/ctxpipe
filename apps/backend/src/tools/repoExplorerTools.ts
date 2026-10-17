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

/**
 * Shared tools for repo exploration (Workspace chat and ingest read their names and descriptions).
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
