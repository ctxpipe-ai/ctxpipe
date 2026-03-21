import { describe, expect, it, vi } from "vitest"

vi.mock("../models/repositories.js", () => ({
  getRepository: vi.fn(),
  listRepositories: vi.fn(),
}))

import { getFileTool } from "../tools/getFile.js"
import { listFilesTool } from "../tools/listFiles.js"
import { listRepositoriesTool } from "../tools/listRepositories.js"
import { searchTool } from "../tools/search.js"
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
  })

})
