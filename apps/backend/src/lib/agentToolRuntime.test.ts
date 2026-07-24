import { describe, expect, it, vi } from "vitest"

vi.mock("../models/repositories.js", () => ({
  getRepositoryForOrg: vi.fn(),
  listRepositoriesForOrg: vi.fn(),
}))

import { getFileTool } from "../tools/getFile.js"
import { listFilesTool } from "../tools/listFiles.js"
import { listRepositoriesTool } from "../tools/listRepositories.js"
import {
  graphCallersTool,
  graphCalleesTool,
  graphFindSymbolTool,
} from "../tools/codegraphTools.js"
import { standardRepoExplorerTools } from "../tools/repoExplorerTools.js"
import { searchTool } from "../tools/search.js"
import {
  findSymbolDefinitionsTool,
  findSymbolReferencesTool,
} from "../tools/symbolTools.js"
import { repositoryIdSchema } from "./agentToolRuntime.js"

describe("interactionGraph helpers", () => {
  it("accepts repository ids with repo_ prefix and fixed payload length", () => {
    expect(
      repositoryIdSchema.safeParse("repo_AAAAAAAAAAAAAAAAAAAAAAAAAA").success,
    ).toBe(true)
  })

  it("rejects repository ids without repo_ prefix", () => {
    expect(repositoryIdSchema.safeParse("backend_repo_1").success).toBe(false)
  })

  it("rejects legacy lowercase base32hex repository ids", () => {
    expect(
      repositoryIdSchema.safeParse("repo_00000000000000000000000000").success,
    ).toBe(false)
  })

  it("exports only tool entrypoints for agent wiring", () => {
    expect(searchTool.name).toBe("search")
    expect(listFilesTool.name).toBe("list_files")
    expect(getFileTool.name).toBe("get_file")
    expect(listRepositoriesTool.name).toBe("list_repositories")
    expect(findSymbolDefinitionsTool.name).toBe("find_symbol_definitions")
    expect(findSymbolReferencesTool.name).toBe("find_symbol_references")
    expect(graphFindSymbolTool.name).toBe("graph_find_symbol")
    expect(graphCallersTool.name).toBe("graph_get_callers")
    expect(graphCalleesTool.name).toBe("graph_get_callees")
    expect(standardRepoExplorerTools).toHaveLength(8)
  })

})
