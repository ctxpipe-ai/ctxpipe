import { HttpResponse, http } from "msw"
import { Octokit } from "octokit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import type { Env } from "../../config/env.js"

const { getInstallationOctokitForOrgMock } = vi.hoisted(() => ({
  getInstallationOctokitForOrgMock: vi.fn(),
}))
const compareCommitsMock = vi.hoisted(() => vi.fn())

afterEach(() => {
  vi.useRealTimers()
})

// getInstallationOctokitForOrg loads the GitHub App installation from Postgres.
vi.mock("../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

type GitTreeEntryBody = {
  path: string
  mode: string
  type: string
  sha?: string | null
  content?: string
}

type GitTreeBody = {
  base_tree?: string
  tree: GitTreeEntryBody[]
}

function installGithubGit(options?: {
  heads?: Array<{ commit: string; tree: string }>
  failFirstUpdate?: boolean
}) {
  const heads = options?.heads ?? [{ commit: "base", tree: "base-tree" }]
  let refReads = 0
  let blobWrites = 0
  let treeWrites = 0
  let commitWrites = 0
  let updateWrites = 0
  let blobInFlight = 0
  let maxBlobInFlight = 0
  const blobs: Array<Record<string, unknown>> = []
  const trees: GitTreeBody[] = []
  const commits: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const blobStartedAt: number[] = []

  server.use(
    http.get("https://api.github.com/repos/acme/docs/git/ref/*", () => {
      const fallback = { commit: "base", tree: "base-tree" }
      const head =
        heads[Math.min(refReads, heads.length - 1)] ?? heads[0] ?? fallback
      refReads += 1
      return HttpResponse.json({
        object: { sha: head.commit, type: "commit" },
      })
    }),
    http.get(
      "https://api.github.com/repos/acme/docs/git/commits/:sha",
      ({ params }) => {
        const sha = String(params.sha)
        const head = heads.find((item) => item.commit === sha) ??
          heads[0] ?? {
            commit: sha,
            tree: "base-tree",
          }
        return HttpResponse.json({ sha, tree: { sha: head.tree } })
      },
    ),
    http.post(
      "https://api.github.com/repos/acme/docs/git/blobs",
      async ({ request }) => {
        blobInFlight += 1
        maxBlobInFlight = Math.max(maxBlobInFlight, blobInFlight)
        blobStartedAt.push(Date.now())
        blobs.push((await request.json()) as Record<string, unknown>)
        blobInFlight -= 1
        blobWrites += 1
        return HttpResponse.json({ sha: `blob-${blobWrites}` })
      },
    ),
    http.post(
      "https://api.github.com/repos/acme/docs/git/trees",
      async ({ request }) => {
        trees.push((await request.json()) as GitTreeBody)
        treeWrites += 1
        return HttpResponse.json({ sha: `tree-${treeWrites}` })
      },
    ),
    http.post(
      "https://api.github.com/repos/acme/docs/git/commits",
      async ({ request }) => {
        commits.push((await request.json()) as Record<string, unknown>)
        commitWrites += 1
        return HttpResponse.json({ sha: `commit-${commitWrites}` })
      },
    ),
    http.patch(
      "https://api.github.com/repos/acme/docs/git/refs/*",
      async ({ request }) => {
        updates.push((await request.json()) as Record<string, unknown>)
        updateWrites += 1
        if (options?.failFirstUpdate && updateWrites === 1) {
          return HttpResponse.json(
            { message: "Update is not a fast forward" },
            { status: 422 },
          )
        }
        return HttpResponse.json({ object: { sha: "updated" } })
      },
    ),
  )

  getInstallationOctokitForOrgMock.mockResolvedValue({
    installation: { installationId: 123 },
    octokit: new Octokit({
      auth: "test-token",
      throttle: { enabled: false },
    }),
  })

  return {
    blobs,
    trees,
    commits,
    updates,
    refReads: () => refReads,
    maxBlobInFlight: () => maxBlobInFlight,
    blobStartedAt,
  }
}

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

describe("commitFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes binary connector assets to GitHub as base64 blobs", async () => {
    const github = installGithubGit()

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

    expect(github.blobs).toEqual([{ content: "iVBORw==", encoding: "base64" }])
    expect(github.maxBlobInFlight()).toBe(1)
    expect(github.trees[0]?.tree).toEqual([
      {
        path: "slack/thread/assets/F1--diagram.png",
        mode: "100644",
        type: "blob",
        sha: "blob-1",
      },
      {
        path: "slack/thread/thread.md",
        mode: "100644",
        type: "blob",
        content: "# Thread",
      },
    ])
  })

  it("writes UTF-8 files as tree content without blob posts", async () => {
    const github = installGithubGit()

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

    expect(github.blobs).toEqual([])
    expect(github.trees).toEqual([
      {
        base_tree: "base-tree",
        tree: [
          { path: "linear/a.md", mode: "100644", type: "blob", content: "a" },
          { path: "linear/b.md", mode: "100644", type: "blob", content: "b" },
        ],
      },
    ])
    expect(github.commits).toEqual([
      {
        message: "Sync Linear",
        tree: "tree-1",
        parents: ["base"],
      },
    ])
    expect(github.updates).toEqual([{ sha: "commit-1" }])
  })

  it("counts a delete toward the 50-entry tree cap", async () => {
    const github = installGithubGit()

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

    expect(github.blobs).toEqual([])
    expect(github.trees).toHaveLength(2)
    const firstTree = github.trees[0]
    const secondTree = github.trees[1]
    expect(firstTree?.base_tree).toBe("base-tree")
    expect(firstTree?.tree).toHaveLength(50)
    expect(firstTree?.tree[0]).toEqual({
      path: "linear/old.md",
      mode: "100644",
      type: "blob",
      sha: null,
    })
    expect(secondTree?.base_tree).toBe("tree-1")
    expect(secondTree?.tree).toEqual([
      {
        path: "linear/issue-49.md",
        mode: "100644",
        type: "blob",
        content: "issue 49",
      },
      {
        path: "linear/issue-50.md",
        mode: "100644",
        type: "blob",
        content: "issue 50",
      },
    ])
    expect(github.commits).toEqual([
      {
        message: "Sync Linear",
        tree: "tree-2",
        parents: ["base"],
      },
    ])
    expect(github.updates).toHaveLength(1)
  })

  it("keeps an oversized file alone and a delete in its own tree", async () => {
    const github = installGithubGit()

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
      deletePaths: ["linear/old.md"],
    })

    expect(github.trees.map((tree) => tree.base_tree)).toEqual([
      "base-tree",
      "tree-1",
      "tree-2",
    ])
    expect(github.trees[0]?.tree).toEqual([
      {
        path: "linear/old.md",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ])
    expect(github.trees[1]?.tree).toHaveLength(1)
    expect(github.trees[1]?.tree[0]?.path).toBe("linear/huge.md")
    expect(github.trees[1]?.tree[0]?.content).toHaveLength(900 * 1024 + 1)
    expect(github.trees[2]?.tree).toEqual([
      {
        path: "linear/small.md",
        mode: "100644",
        type: "blob",
        content: "s",
      },
    ])
  })

  it("posts base64 blobs serially and references their shas", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] })
    const github = installGithubGit()

    let settled = false
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
    }).finally(() => {
      settled = true
    })
    // msw answers over real I/O and Octokit's Bottleneck yields on
    // setTimeout(0), so step the fake clock one timer at a time. Only the
    // client's spacing delay moves it, so request latency cannot skew the gap.
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersToNextTimerAsync()
    }
    await expect(pending).resolves.toMatchObject({ commitSha: "commit-1" })

    expect(github.blobs).toEqual([
      { content: "aaa", encoding: "base64" },
      { content: "bbb", encoding: "base64" },
    ])
    expect(github.maxBlobInFlight()).toBe(1)
    expect(github.blobStartedAt).toHaveLength(2)
    expect(
      (github.blobStartedAt[1] ?? 0) - (github.blobStartedAt[0] ?? 0),
    ).toBeGreaterThanOrEqual(1_000)
    expect(github.trees[0]?.tree).toEqual([
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
    ])
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
    const github = installGithubGit({
      heads: [
        { commit: "base-1", tree: "tree-1" },
        { commit: "base-2", tree: "tree-2" },
      ],
      failFirstUpdate: true,
    })

    const result = await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Sync Notion",
      files: [{ path: "notion/page.md", content: "# Page\n" }],
    })

    expect(github.refReads()).toBe(2)
    expect(github.blobs).toEqual([])
    expect(github.trees[0]).toEqual({
      base_tree: "tree-1",
      tree: [
        {
          path: "notion/page.md",
          mode: "100644",
          type: "blob",
          content: "# Page\n",
        },
      ],
    })
    expect(github.trees[1]?.base_tree).toBe("tree-2")
    expect(github.trees[1]?.tree).toEqual(github.trees[0]?.tree)
    expect(github.commits[1]?.parents).toEqual(["base-2"])
    expect(github.updates).toHaveLength(2)
    expect(result.commitSha).toBe("commit-2")
  })

  it("does not recreate a binary blob when the ref update is retried", async () => {
    const github = installGithubGit({
      heads: [
        { commit: "base-1", tree: "tree-1" },
        { commit: "base-2", tree: "tree-2" },
      ],
      failFirstUpdate: true,
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

    expect(github.blobs).toEqual([{ content: "iVBORw==", encoding: "base64" }])
    expect(github.trees).toHaveLength(2)
    expect(github.trees[0]?.tree).toEqual([
      {
        path: "linear/diagram.png",
        mode: "100644",
        type: "blob",
        sha: "blob-1",
      },
    ])
    expect(github.trees[1]?.base_tree).toBe("tree-2")
    expect(github.trees[1]?.tree).toEqual(github.trees[0]?.tree)
    expect(github.updates).toHaveLength(2)
  })

  it("returns the current head when there is nothing to write", async () => {
    const github = installGithubGit()

    const result = await commitFiles({
      orgId: "org_test",
      repositoryName: "acme/docs",
      env: {} as never,
      branch: "main",
      message: "Sync Linear",
      files: [],
    })

    expect(result.commitSha).toBe("base")
    expect(github.blobs).toEqual([])
    expect(github.trees).toEqual([])
    expect(github.commits).toEqual([])
    expect(github.updates).toEqual([])
  })
})
