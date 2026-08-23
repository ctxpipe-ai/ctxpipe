import { beforeEach, describe, expect, it, vi } from "vitest"

const getRepositoryForOrg = vi.hoisted(() => vi.fn())
const fetchCheckoutFileBytes = vi.hoisted(() => vi.fn())
const requireCurrentOrgId = vi.hoisted(() => vi.fn(() => "org_1"))

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId,
}))

vi.mock("../models/repositories.js", () => ({
  getRepositoryForOrg,
}))

vi.mock("../domain/codeIngestion/codesearchClient.js", () => ({
  fetchCheckoutFileBytes,
}))

import { getFileTool } from "./getFile.js"

const REPO_ID = "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa"

describe("get_file", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRepositoryForOrg.mockResolvedValue({
      id: REPO_ID,
      orgId: "org_1",
    })
    fetchCheckoutFileBytes.mockResolvedValue(
      Buffer.from("line one\nline two\n", "utf8"),
    )
  })

  it("reads the workspace checkout through the shared helper", async () => {
    const result = await getFileTool.invoke({
      repositoryId: REPO_ID,
      path: "src/a.ts",
      workspaceId: "ws_1",
      mode: "full",
    })
    expect(fetchCheckoutFileBytes).toHaveBeenCalledWith({
      repositoryId: REPO_ID,
      orgId: "org_1",
      workspaceId: "ws_1",
      path: "src/a.ts",
    })
    expect(String(result)).toContain("line one")
  })

  it("throws when the checkout file is missing", async () => {
    fetchCheckoutFileBytes.mockResolvedValue(null)
    await expect(
      getFileTool.invoke({
        repositoryId: REPO_ID,
        path: "missing.ts",
        workspaceId: "ws_1",
      }),
    ).rejects.toThrow("file not found: missing.ts")
  })
})
