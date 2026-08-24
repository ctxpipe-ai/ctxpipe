import { beforeEach, describe, expect, it, vi } from "vitest"

const findRepositoriesByNormalizedGitUrls = vi.hoisted(() => vi.fn())
const globCheckoutFiles = vi.hoisted(() => vi.fn())
const fetchCheckoutFileBytes = vi.hoisted(() => vi.fn())
const requireCurrentOrgId = vi.hoisted(() => vi.fn(() => "org_1"))

vi.mock("../../auth/context.js", () => ({
  requireCurrentOrgId,
}))

vi.mock("../../models/repositories.js", () => ({
  findRepositoriesByNormalizedGitUrls,
}))

vi.mock("../codeIngestion/codesearchClient.js", () => ({
  CodesearchCheckoutError: class CodesearchCheckoutError extends Error {
    readonly status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "CodesearchCheckoutError"
      this.status = status
    }
  },
  globCheckoutFiles,
  fetchCheckoutFileBytes,
}))

import { CodesearchCheckoutError } from "../codeIngestion/codesearchClient.js"
import {
  listWorkspaceCheckoutPaths,
  readWorkspaceCheckoutFile,
  WorkspaceCheckoutReadError,
} from "./checkout-read.js"

describe("workspace checkout reads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findRepositoriesByNormalizedGitUrls.mockResolvedValue([
      {
        id: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        gitUrl: "https://github.com/acme/docs",
      },
    ])
  })

  it("lists file paths from the workspace checkout", async () => {
    globCheckoutFiles.mockResolvedValue({
      entries: [
        { name: "AGENTS.md", path: "AGENTS.md", type: "file" },
        { name: "src", path: "src", type: "dir" },
      ],
      truncated: false,
      matched: 2,
    })
    await expect(
      listWorkspaceCheckoutPaths({
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
      }),
    ).resolves.toEqual(["AGENTS.md"])
    expect(globCheckoutFiles).toHaveBeenCalledWith({
      repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      orgId: "org_1",
      workspaceId: "ws_1",
    })
  })

  it("returns 409 when the workspace repository is not attached yet", async () => {
    findRepositoriesByNormalizedGitUrls.mockResolvedValue([])
    await expect(
      listWorkspaceCheckoutPaths({
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceCheckoutReadError",
      status: 409,
    })
    expect(globCheckoutFiles).not.toHaveBeenCalled()
  })

  it("maps a missing codesearch checkout to 409", async () => {
    globCheckoutFiles.mockRejectedValue(
      new CodesearchCheckoutError("globFiles failed: 404", 404),
    )
    await expect(
      listWorkspaceCheckoutPaths({
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
      }),
    ).rejects.toBeInstanceOf(WorkspaceCheckoutReadError)
  })

  it("reads file bytes from the workspace checkout", async () => {
    fetchCheckoutFileBytes.mockResolvedValue(Buffer.from("# Ledger\n", "utf8"))
    await expect(
      readWorkspaceCheckoutFile({
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
        path: "knowledge/ledger.md",
      }),
    ).resolves.toEqual({
      kind: "bytes",
      bytes: Buffer.from("# Ledger\n", "utf8"),
    })
    expect(fetchCheckoutFileBytes).toHaveBeenCalledWith({
      repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      orgId: "org_1",
      workspaceId: "ws_1",
      path: "knowledge/ledger.md",
    })
  })

  it("returns missing when the checkout file is absent", async () => {
    fetchCheckoutFileBytes.mockResolvedValue(null)
    await expect(
      readWorkspaceCheckoutFile({
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
        path: "missing.md",
      }),
    ).resolves.toEqual({ kind: "missing" })
  })
})
