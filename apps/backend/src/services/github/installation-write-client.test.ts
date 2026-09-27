import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"

const { getInstallationOctokitForOrgMock } = vi.hoisted(() => ({
  getInstallationOctokitForOrgMock: vi.fn(),
}))
const compareCommitsMock = vi.hoisted(() => vi.fn())

afterEach(() => {
  vi.useRealTimers()
})

vi.mock("../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

import {
  commitFiles,
  compareCommitsTouchesPath,
  getCommitTimestamp,
  getFileContentBytes,
  getPullRequestHeadBranch,
  listFilesAtSha,
  listFilesInTree,
  listFilesInTreeWithMetadata,
} from "./installation-write-client.js"

function writeBranchOctokit(rest: Record<string, unknown>) {
  return {
    installation: { installationId: 123 },
    octokit: {
      rest: {
        repos: {
          get: vi.fn(async () => ({ data: { default_branch: "main" } })),
        },
        ...rest,
      },
    },
  }
}

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

  it("matches renamed files by their previous path", async () => {
    compareCommitsMock.mockResolvedValue({
      data: {
        files: [
          {
            filename: "linear/config-archived.yaml",
            previous_filename: "linear/config.yaml",
          },
        ],
      },
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

describe("listFilesInTree", () => {
  it("falls back to walking non-recursive trees when GitHub truncates", async () => {
    const getTree = vi.fn(
      async ({
        tree_sha: treeSha,
        recursive,
      }: {
        tree_sha: string
        recursive?: string
      }) => {
        if (recursive === "true") {
          return {
            data: {
              truncated: true,
              tree: [],
            },
          }
        }
        if (treeSha === "tree") {
          return {
            data: {
              truncated: false,
              tree: [
                { type: "blob", path: "README.md", sha: "readme" },
                { type: "tree", path: "slack", sha: "slack-tree" },
              ],
            },
          }
        }
        return {
          data: {
            truncated: false,
            tree: [{ type: "blob", path: "thread.md", sha: "thread" }],
          },
        }
      },
    )
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 42 },
      octokit: {
        rest: {
          git: {
            getRef: vi.fn(async () => ({
              data: { object: { sha: "base" } },
            })),
            getCommit: vi.fn(async () => ({
              data: { tree: { sha: "tree" } },
            })),
            getTree,
          },
        },
      },
    })
    const input = {
      orgId: "org_1",
      repositoryName: "acme/context",
      env: {} as Env,
      branch: "main",
    }

    await expect(listFilesInTreeWithMetadata(input)).resolves.toEqual({
      files: [
        { path: "README.md", sha: "readme" },
        { path: "slack/thread.md", sha: "thread" },
      ],
      truncated: false,
    })
    await expect(listFilesInTree(input)).resolves.toEqual([
      { path: "README.md", sha: "readme" },
      { path: "slack/thread.md", sha: "thread" },
    ])
    expect(getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "slack-tree" }),
    )
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

describe("commitFiles", () => {
  const branch = "ctxpipe/session"

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes binary connector assets to GitHub as base64 blobs", async () => {
    let activeUploads = 0
    let maxConcurrentUploads = 0
    const createBlob = vi.fn(async () => {
      activeUploads += 1
      maxConcurrentUploads = Math.max(maxConcurrentUploads, activeUploads)
      await Promise.resolve()
      activeUploads -= 1
      return { data: { sha: `blob-${createBlob.mock.calls.length}` } }
    })
    getInstallationOctokitForOrgMock.mockResolvedValue(
      writeBranchOctokit({
        git: {
          getRef: vi.fn(async () => ({
            data: { object: { sha: "base" } },
          })),
          getCommit: vi.fn(async () => ({
            data: { tree: { sha: "base-tree" } },
          })),
          createBlob,
          createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
          createCommit: vi.fn(async () => ({
            data: { sha: "asset-commit" },
          })),
          updateRef: vi.fn(async () => ({ data: {} })),
        },
      }),
    )

    await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch,
      message: "Capture image",
      files: [
        {
          path: "slack/thread/assets/F1--diagram.png",
          content: "iVBORw==",
          encoding: "base64",
        },
        {
          path: "slack/thread/thread.md",
          content: "# Thread",
        },
      ],
    })

    expect(createBlob).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      content: "iVBORw==",
      encoding: "base64",
    })
    expect(maxConcurrentUploads).toBe(1)
  })

  it("honours GitHub Retry-After on secondary rate limits", async () => {
    vi.useFakeTimers()
    const createBlob = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("secondary rate limit"), {
          status: 403,
          response: { headers: { "retry-after": "2" } },
        }),
      )
      .mockResolvedValue({ data: { sha: "blob" } })
    getInstallationOctokitForOrgMock.mockResolvedValue(
      writeBranchOctokit({
        git: {
          getRef: vi.fn(async () => ({
            data: { object: { sha: "base" } },
          })),
          getCommit: vi.fn(async () => ({
            data: { tree: { sha: "base-tree" } },
          })),
          createBlob,
          createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
          createCommit: vi.fn(async () => ({
            data: { sha: "asset-commit" },
          })),
          updateRef: vi.fn(async () => ({ data: {} })),
        },
      }),
    )

    const pending = commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch,
      message: "Capture image",
      files: [{ path: "asset.bin", content: "eA==", encoding: "base64" }],
    })
    const completion = expect(pending).resolves.toMatchObject({
      commitSha: "asset-commit",
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(createBlob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await completion
    expect(createBlob).toHaveBeenCalledTimes(2)
  })

  it("does not retry a primary rate limit before its reset time", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"))
    const resetSeconds = Math.floor((Date.now() + 1_200_000) / 1000)
    const createBlob = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("API rate limit exceeded"), {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetSeconds),
            },
          },
        }),
      )
      .mockResolvedValue({ data: { sha: "blob" } })
    getInstallationOctokitForOrgMock.mockResolvedValue(
      writeBranchOctokit({
        git: {
          getRef: vi.fn(async () => ({
            data: { object: { sha: "base" } },
          })),
          getCommit: vi.fn(async () => ({
            data: { tree: { sha: "base-tree" } },
          })),
          createBlob,
          createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
          createCommit: vi.fn(async () => ({
            data: { sha: "asset-commit" },
          })),
          updateRef: vi.fn(async () => ({ data: {} })),
        },
      }),
    )

    const pending = commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch,
      message: "Capture image",
      files: [{ path: "asset.bin", content: "eA==", encoding: "base64" }],
    })
    const completion = expect(pending).resolves.toMatchObject({
      commitSha: "asset-commit",
    })
    await vi.advanceTimersByTimeAsync(1_199_999)
    expect(createBlob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await completion
    expect(createBlob).toHaveBeenCalledTimes(2)
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
    const createBlob = vi.fn(async () => ({ data: { sha: "blob" } }))

    getInstallationOctokitForOrgMock.mockResolvedValue(
      writeBranchOctokit({
        git: {
          getRef,
          getCommit,
          createBlob,
          createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
          createCommit,
          updateRef,
        },
      }),
    )

    const result = await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch,
      message: "Sync Notion",
      files: [{ path: "notion/page.md", content: "# Page\n" }],
    })

    expect(getRef).toHaveBeenCalledTimes(2)
    expect(createBlob).toHaveBeenCalledTimes(1)
    expect(createCommit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parents: ["base-2"] }),
    )
    expect(updateRef).toHaveBeenCalledTimes(2)
    expect(result.commitSha).toBe("commit-2")
  })
})
