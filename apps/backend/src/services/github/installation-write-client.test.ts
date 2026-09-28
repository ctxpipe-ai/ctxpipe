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
  createPullRequestWithFiles,
  getPullRequestHeadBranch,
  listFilesInTree,
  listFilesInTreeWithMetadata,
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
      files: [{ path: "linear/config.yaml", content: "teams: []\n" }],
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

type CreatedTreeCall = {
  base_tree: string
  tree: Array<{
    path: string
    mode: string
    type: string
    sha?: string | null
    content?: string
  }>
}

describe("commitFiles", () => {
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
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
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
        },
      },
    })

    await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
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

    expect(createBlob).toHaveBeenCalledTimes(1)
    expect(createBlob).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      content: "iVBORw==",
      encoding: "base64",
    })
    expect(maxConcurrentUploads).toBe(1)
  })

  it("writes UTF-8 files as tree content without blob posts", async () => {
    const createBlob = vi.fn()
    const createTree = vi.fn(async () => ({ data: { sha: "tree" } }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef: vi.fn(async () => ({
              data: { object: { sha: "base" } },
            })),
            getCommit: vi.fn(async () => ({
              data: { tree: { sha: "base-tree" } },
            })),
            createBlob,
            createTree,
            createCommit: vi.fn(async () => ({ data: { sha: "text-commit" } })),
            updateRef: vi.fn(async () => ({ data: {} })),
          },
        },
      },
    })

    await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Sync Linear",
      files: [
        { path: "linear/a.md", content: "a" },
        { path: "linear/b.md", content: "b" },
      ],
    })

    expect(createBlob).not.toHaveBeenCalled()
    expect(createTree).toHaveBeenCalledTimes(1)
    expect(createTree).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      base_tree: "base-tree",
      tree: [
        { path: "linear/a.md", mode: "100644", type: "blob", content: "a" },
        { path: "linear/b.md", mode: "100644", type: "blob", content: "b" },
      ],
    })
  })

  it("chains a second tree after 50 UTF-8 files and puts deletes on the first", async () => {
    const createBlob = vi.fn()
    const createTree = vi.fn(async (_request: CreatedTreeCall) => ({
      data: { sha: `tree-${createTree.mock.calls.length}` },
    }))
    const createCommit = vi.fn(async () => ({ data: { sha: "commit" } }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef: vi.fn(async () => ({
              data: { object: { sha: "base" } },
            })),
            getCommit: vi.fn(async () => ({
              data: { tree: { sha: "base-tree" } },
            })),
            createBlob,
            createTree,
            createCommit,
            updateRef: vi.fn(async () => ({ data: {} })),
          },
        },
      },
    })

    await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Sync Linear",
      files: Array.from({ length: 51 }, (_, index) => ({
        path: `linear/issue-${index}.md`,
        content: `issue ${index}`,
      })),
      deletePaths: ["linear/old.md"],
    })

    expect(createBlob).not.toHaveBeenCalled()
    expect(createTree).toHaveBeenCalledTimes(2)
    const firstTree = createTree.mock.calls[0]?.[0]
    const secondTree = createTree.mock.calls[1]?.[0]
    expect(firstTree?.base_tree).toBe("base-tree")
    expect(firstTree?.tree).toHaveLength(51)
    expect(firstTree?.tree?.at(-1)).toEqual({
      path: "linear/old.md",
      mode: "100644",
      type: "blob",
      sha: null,
    })
    expect(secondTree?.base_tree).toBe("tree-1")
    expect(secondTree?.tree).toEqual([
      {
        path: "linear/issue-50.md",
        mode: "100644",
        type: "blob",
        content: "issue 50",
      },
    ])
    expect(createCommit).toHaveBeenCalledTimes(1)
    expect(createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ tree: "tree-2", parents: ["base"] }),
    )
  })

  it("gives a UTF-8 file larger than 900 KB its own tree", async () => {
    const createTree = vi.fn(async (_request: CreatedTreeCall) => ({
      data: { sha: "tree" },
    }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef: vi.fn(async () => ({
              data: { object: { sha: "base" } },
            })),
            getCommit: vi.fn(async () => ({
              data: { tree: { sha: "base-tree" } },
            })),
            createBlob: vi.fn(),
            createTree,
            createCommit: vi.fn(async () => ({ data: { sha: "commit" } })),
            updateRef: vi.fn(async () => ({ data: {} })),
          },
        },
      },
    })

    await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Sync Linear",
      files: [
        { path: "linear/huge.md", content: "x".repeat(900 * 1024 + 1) },
        { path: "linear/small.md", content: "s" },
      ],
    })

    expect(createTree).toHaveBeenCalledTimes(2)
    const hugeTree = createTree.mock.calls[0]?.[0]
    const smallTree = createTree.mock.calls[1]?.[0]
    expect(hugeTree?.tree).toHaveLength(1)
    expect(hugeTree?.tree?.[0]?.path).toBe("linear/huge.md")
    expect(smallTree?.tree).toEqual([
      {
        path: "linear/small.md",
        mode: "100644",
        type: "blob",
        content: "s",
      },
    ])
  })

  it("posts base64 blobs serially and references their shas", async () => {
    vi.useFakeTimers()
    const createBlob = vi.fn(async () => ({
      data: { sha: `blob-${createBlob.mock.calls.length}` },
    }))
    const createTree = vi.fn(async () => ({ data: { sha: "tree" } }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef: vi.fn(async () => ({
              data: { object: { sha: "base" } },
            })),
            getCommit: vi.fn(async () => ({
              data: { tree: { sha: "base-tree" } },
            })),
            createBlob,
            createTree,
            createCommit: vi.fn(async () => ({
              data: { sha: "asset-commit" },
            })),
            updateRef: vi.fn(async () => ({ data: {} })),
          },
        },
      },
    })

    const pending = commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Capture images",
      files: [
        { path: "linear/a.png", content: "aaa", encoding: "base64" },
        { path: "linear/b.png", content: "bbb", encoding: "base64" },
      ],
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(createBlob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(createBlob).toHaveBeenCalledTimes(2)
    expect(createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        tree: [
          {
            path: "linear/a.png",
            mode: "100644",
            type: "blob",
            sha: "blob-1",
          },
          {
            path: "linear/b.png",
            mode: "100644",
            type: "blob",
            sha: "blob-2",
          },
        ],
      }),
    )
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
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
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
        },
      },
    })

    const pending = commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
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
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
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
        },
      },
    })

    const pending = commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
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
    const createTree = vi.fn(async (_request: CreatedTreeCall) => ({
      data: { sha: "tree" },
    }))

    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef,
            getCommit,
            createBlob,
            createTree,
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
    expect(createBlob).not.toHaveBeenCalled()
    expect(createTree).toHaveBeenCalledTimes(2)
    expect(createTree.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        base_tree: "tree-1",
        tree: [
          {
            path: "notion/page.md",
            mode: "100644",
            type: "blob",
            content: "# Page\n",
          },
        ],
      }),
    )
    expect(createTree.mock.calls[1]?.[0]?.base_tree).toBe("tree-2")
    expect(createCommit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parents: ["base-2"] }),
    )
    expect(updateRef).toHaveBeenCalledTimes(2)
    expect(result.commitSha).toBe("commit-2")
  })

  it("does not recreate a binary blob when the ref update is retried", async () => {
    const createBlob = vi.fn(async () => ({ data: { sha: "blob-bin" } }))
    const createTree = vi.fn(async (_request: CreatedTreeCall) => ({
      data: { sha: "tree" },
    }))
    const updateRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce({ data: {} })
    const getCommit = vi
      .fn()
      .mockResolvedValueOnce({ data: { tree: { sha: "tree-1" } } })
      .mockResolvedValueOnce({ data: { tree: { sha: "tree-2" } } })
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 123 },
      octokit: {
        rest: {
          git: {
            getRef: vi
              .fn()
              .mockResolvedValueOnce({ data: { object: { sha: "base-1" } } })
              .mockResolvedValueOnce({ data: { object: { sha: "base-2" } } }),
            getCommit,
            createBlob,
            createTree,
            createCommit: vi
              .fn()
              .mockResolvedValueOnce({ data: { sha: "commit-1" } })
              .mockResolvedValueOnce({ data: { sha: "commit-2" } }),
            updateRef,
          },
        },
      },
    })

    await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Capture image",
      files: [
        { path: "linear/diagram.png", content: "iVBORw==", encoding: "base64" },
      ],
    })

    expect(createBlob).toHaveBeenCalledTimes(1)
    expect(createTree).toHaveBeenCalledTimes(2)
    expect(createTree.mock.calls[0]?.[0]?.tree).toEqual([
      {
        path: "linear/diagram.png",
        mode: "100644",
        type: "blob",
        sha: "blob-bin",
      },
    ])
    expect(createTree.mock.calls[1]?.[0]?.base_tree).toBe("tree-2")
    expect(updateRef).toHaveBeenCalledTimes(2)
  })
})
