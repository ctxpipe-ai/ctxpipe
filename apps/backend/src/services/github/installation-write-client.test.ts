import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"

const { getInstallationOctokitForOrgMock } = vi.hoisted(() => ({
  getInstallationOctokitForOrgMock: vi.fn(),
}))
const compareCommitsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

import {
  commitFiles,
  compareCommitsTouchesPath,
  createPullRequestWithFiles,
  getCommitTimestamp,
  getFileContentBytes,
  getPullRequestHeadBranch,
  listFilesAtSha,
} from "./installation-write-client.js"

describe("createPullRequestWithFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("initializes an empty repository before creating the config pull request", async () => {
    let initialized = false
    const getRef = vi.fn(async ({ ref }: { ref: string }) => {
      if (ref === "heads/main" && !initialized) {
        throw Object.assign(new Error("Git Repository is empty."), {
          status: 409,
        })
      }
      return { data: { object: { sha: "base-commit" } } }
    })
    const createOrUpdateFileContents = vi.fn(async () => {
      initialized = true
      return { data: {} }
    })
    const createRef = vi.fn(async () => ({ data: {} }))
    const pullsCreate = vi.fn(async () => ({
      data: {
        number: 1,
        html_url: "https://github.com/acme/docs/pull/1",
      },
    }))

    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef,
            getCommit: vi.fn(async () => ({
              data: { tree: { sha: "base-tree" } },
            })),
            createRef,
            createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
            createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
            createCommit: vi.fn(async () => ({
              data: { sha: "config-commit" },
            })),
            updateRef: vi.fn(async () => ({ data: {} })),
          },
          repos: {
            createOrUpdateFileContents,
          },
          pulls: {
            create: pullsCreate,
          },
        },
      },
    })

    const env = {} as Env
    const result = await createPullRequestWithFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env,
      githubConnectionId: "con_github",
      baseBranch: "main",
      title: "Configure Linear sync",
      body: "Review and merge.",
      commitMessage: "Configure Linear sync",
      files: [{ path: "linear/config.yaml", content: "scope: {}\n" }],
      featureBranchPrefix: "ctxpipe/linear-config",
    })

    expect(createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      path: ".gitkeep",
      message: "Initialize repository for ctxpipe",
      content: "Cg==",
    })
    expect(createRef).toHaveBeenCalled()
    expect(pullsCreate).toHaveBeenCalled()
    expect(result.pullUrl).toBe("https://github.com/acme/docs/pull/1")
    expect(getInstallationOctokitForOrgMock).toHaveBeenNthCalledWith(
      2,
      "org_test",
      env,
      "con_github",
    )
  })
})

describe("compareCommitsTouchesPath", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 42 },
      octokit: {
        rest: { repos: { compareCommits: compareCommitsMock } },
      },
    })
  })

  it("passes separate base and head refs to Octokit", async () => {
    compareCommitsMock.mockResolvedValue({
      data: { files: [{ filename: "linear/config.yaml" }] },
    })

    await expect(
      compareCommitsTouchesPath({
        orgId: "org_1",
        repositoryName: "acme/context",
        env: {} as Env,
        baseSha: "base-sha",
        headSha: "head-sha",
        path: "linear/config.yaml",
      }),
    ).resolves.toBe(true)
    expect(compareCommitsMock).toHaveBeenCalledWith({
      owner: "acme",
      repo: "context",
      base: "base-sha",
      head: "head-sha",
    })
  })
})

describe("getPullRequestHeadBranch", () => {
  it("resolves the PR number with the installation client", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { head: { ref: "ctxpipe/linear-config-123" } },
    })
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 42 },
      octokit: { rest: { pulls: { get: pullsGet } } },
    })

    await expect(
      getPullRequestHeadBranch({
        orgId: "org_1",
        repositoryName: "acme/context",
        githubConnectionId: "con_github",
        env: {} as Env,
        pullUrl: "https://github.com/acme/context/pull/17",
      }),
    ).resolves.toBe("ctxpipe/linear-config-123")
    expect(pullsGet).toHaveBeenCalledWith({
      owner: "acme",
      repo: "context",
      pull_number: 17,
    })
  })
})

describe("commitFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rebuilds the commit on the latest head after a concurrent update", async () => {
    const getRef = vi
      .fn()
      .mockResolvedValueOnce({ data: { object: { sha: "base-1" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "base-2" } } })
    const getCommit = vi
      .fn()
      .mockResolvedValueOnce({ data: { tree: { sha: "tree-1" } } })
      .mockResolvedValueOnce({ data: { tree: { sha: "tree-2" } } })
    const createCommit = vi
      .fn()
      .mockResolvedValueOnce({ data: { sha: "commit-1" } })
      .mockResolvedValueOnce({ data: { sha: "commit-2" } })
    const updateRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce({ data: {} })

    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef,
            getCommit,
            createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
            createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
            createCommit,
            updateRef,
          },
        },
      },
    })

    const result = await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Sync Notion",
      files: [{ path: "notion/page.md", content: "# Page\n" }],
    })

    expect(getRef).toHaveBeenCalledTimes(2)
    expect(createCommit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parents: ["base-2"] }),
    )
    expect(updateRef).toHaveBeenCalledTimes(2)
    expect(result.commitSha).toBe("commit-2")
  })

  it("commits against the captured parent and does not overlay after a non-fast-forward", async () => {
    const getRef = vi.fn()
    const getCommit = vi.fn(async () => ({
      data: { tree: { sha: "tree-captured" } },
    }))
    const createCommit = vi.fn(async () => ({ data: { sha: "commit-cas" } }))
    const updateRef = vi.fn().mockRejectedValue(
      Object.assign(new Error("Update is not a fast forward"), {
        status: 422,
      }),
    )

    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef,
            getCommit,
            createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
            createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
            createCommit,
            updateRef,
          },
        },
      },
    })

    await expect(
      commitFiles({
        orgId: "org_test",
        repositoryName: "acme/docs",
        env: {} as never,
        branch: "main",
        message: "Knowledge update",
        files: [{ path: "knowledge/imported/a.md", content: "# A\n" }],
        expectedParentSha: "captured-sha",
      }),
    ).rejects.toMatchObject({ status: 422 })

    expect(getRef).not.toHaveBeenCalled()
    expect(getCommit).toHaveBeenCalledWith(
      expect.objectContaining({ commit_sha: "captured-sha" }),
    )
    expect(createCommit).toHaveBeenCalledTimes(1)
    expect(createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ parents: ["captured-sha"] }),
    )
    expect(updateRef).toHaveBeenCalledTimes(1)
  })
})

describe("listFilesAtSha", () => {
  it("reads the tree at a SHA without initializing an empty repository", async () => {
    const getTree = vi.fn(async () => ({
      data: {
        tree: [{ type: "blob", path: "AGENTS.md", sha: "blob-1" }],
      },
    }))
    const createOrUpdateFileContents = vi.fn()
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 1 },
      octokit: {
        rest: {
          git: { getTree },
          repos: { createOrUpdateFileContents },
        },
      },
    })
    await expect(
      listFilesAtSha({
        orgId: "org_test",
        repositoryName: "acme/docs",
        env: {} as Env,
        sha: "desired-sha",
      }),
    ).resolves.toEqual([{ path: "AGENTS.md", sha: "blob-1" }])
    expect(getTree).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      tree_sha: "desired-sha",
      recursive: "true",
    })
    expect(createOrUpdateFileContents).not.toHaveBeenCalled()
  })

  it("rethrows a missing tree when the caller asks not to mask 404s", async () => {
    const getTree = vi.fn(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 1 },
      octokit: { rest: { git: { getTree } } },
    })
    await expect(
      listFilesAtSha({
        orgId: "org_test",
        repositoryName: "acme/docs",
        env: {} as Env,
        sha: "missing-sha",
        missing: "throw",
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("getFileContentBytes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns omitted when GitHub withholds the blob body", async () => {
    const getContent = vi.fn(async () => ({
      data: { encoding: "none", size: 2_000_000, content: "" },
    }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 1 },
      octokit: { rest: { repos: { getContent } } },
    })
    await expect(
      getFileContentBytes({
        orgId: "org_test",
        repositoryName: "acme/docs",
        env: {} as Env,
        branch: "abc",
        path: "logo.png",
      }),
    ).resolves.toEqual({ kind: "omitted" })
  })

  it("returns raw bytes without UTF-8 decoding", async () => {
    const getContent = vi.fn(async () => ({
      data: {
        encoding: "base64",
        size: 4,
        content: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64"),
      },
    }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 1 },
      octokit: { rest: { repos: { getContent } } },
    })
    const result = await getFileContentBytes({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as Env,
      branch: "abc",
      path: "logo.png",
    })
    expect(result).toEqual({
      kind: "bytes",
      bytes: Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    })
  })
})

describe("getCommitTimestamp", () => {
  it("returns the committer date as ISO", async () => {
    const getCommit = vi.fn(async () => ({
      data: {
        committer: { date: "2026-08-16T12:00:00Z" },
        author: { date: "2026-08-15T12:00:00Z" },
      },
    }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 1 },
      octokit: { rest: { git: { getCommit } } },
    })
    await expect(
      getCommitTimestamp({
        orgId: "org_test",
        repositoryName: "acme/docs",
        env: {} as Env,
        sha: "abc",
      }),
    ).resolves.toBe("2026-08-16T12:00:00.000Z")
    expect(getCommit).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      commit_sha: "abc",
    })
  })
})
