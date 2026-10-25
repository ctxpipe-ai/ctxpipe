import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { registerMcpReadTools } from "./framework/tool-registry.js"
import { registerWorkspaceFileResource } from "./resources/workspace-file.js"
import { findSymbolTool } from "./tools/find-symbol.js"
import { getRelatedTool } from "./tools/get-related.js"
import { listFilesTool } from "./tools/list-files.js"
import { listWorkspaces } from "./tools/list-workspaces.js"
import { readFileTool } from "./tools/read-file.js"
import { searchCodeTool } from "./tools/search-code.js"
import { searchKnowledgeTool } from "./tools/search-knowledge.js"

/**
 * The public MCP surface of `/mcp` (ADR-051): the seven read tools in the
 * `tools/list` order of the ADR, and the workspace-file resource template.
 */
export function registerMcpTools(server: McpServer): void {
  registerMcpReadTools(server, [
    listWorkspaces,
    searchKnowledgeTool,
    searchCodeTool,
    findSymbolTool,
    readFileTool,
    listFilesTool,
    getRelatedTool,
  ])
  registerWorkspaceFileResource(server)
}
