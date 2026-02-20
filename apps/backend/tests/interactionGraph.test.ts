import { describe, expect, it } from "vitest"
import { repositoryIdSchema } from "../src/lib/agentToolRuntime.js"
import { getFileTool } from "../src/tools/getFile.js"
import { listFilesTool } from "../src/tools/listFiles.js"
import { listRepositoriesTool } from "../src/tools/listRepositories.js"
import { searchTool } from "../src/tools/search.js"

describe("interactionGraph helpers", () => {
  it("accepts repository ids with repo_ prefix", () => {
    expect(repositoryIdSchema.safeParse("repo_ABCDEF27").success).toBe(true)
  })

  it("rejects repository ids without repo_ prefix", () => {
    expect(repositoryIdSchema.safeParse("backend_repo_1").success).toBe(false)
  })

  it("exports only tool entrypoints for agent wiring", () => {
    expect(searchTool.name).toBe("search")
    expect(listFilesTool.name).toBe("list_files")
    expect(getFileTool.name).toBe("get_file")
    expect(listRepositoriesTool.name).toBe("list_repositories")
  })
})
