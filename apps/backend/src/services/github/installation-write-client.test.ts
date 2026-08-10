import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"

const getInstallationOctokitForOrgMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

import { createPullRequestWithFiles } from "./installation-write-client.js"

function createOctokitMock() {
  return {
    rest: {
      git: {
        getRef: vi.fn(),
        getCommit: vi.fn(),
        createRef: vi.fn(),
        createBlob: vi.fn(),
        createTree: vi.fn(),
        createCommit: vi.fn(),
        updateRef: vi.fn(),
      },
      pulls: {
        create: vi.fn(),
      },
    },
  }
}

function baseInput(octokit: ReturnType<typeof createOctokitMock>) {
  getInstallationOctokitForOrgMock.mockResolvedValue({
    installation: { installationId: 123 },
    octokit,
  })
  return {
    orgId: "org_1",
    env: {} as Env,
    repositoryName: "acme/docs",
    githubConnectionId: "con_github",
    baseBranch: "main",
    title: "Update Confluence sync configuration",
    body: "Update confluence/config.yaml",
    commitMessage: "chore(confluence): update sync config.yaml",
    files: [{ path: "confluence/config.yaml", content: "version: 1\n" }],
  }
}

describe("createPullRequestWithFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("creates a config pull request from an existing base branch", async () => {
    const octokit = createOctokitMock()
    octokit.rest.git.getRef
      .mockResolvedValueOnce({ data: { object: { sha: "base-sha" } } })
      .mockResolvedValueOnce({ data: { object: { sha: "feature-base-sha" } } })
    octokit.rest.git.getCommit
      .mockResolvedValueOnce({ data: { tree: { sha: "base-tree" } } })
      .mockResolvedValueOnce({ data: { tree: { sha: "feature-tree" } } })
    octokit.rest.git.createBlob.mockResolvedValueOnce({
      data: { sha: "config-blob" },
    })
    octokit.rest.git.createTree.mockResolvedValueOnce({
      data: { sha: "config-tree" },
    })
    octokit.rest.git.createCommit.mockResolvedValueOnce({
      data: { sha: "config-commit" },
    })
    octokit.rest.pulls.create.mockResolvedValueOnce({
      data: {
        number: 7,
        html_url: "https://github.com/acme/docs/pull/7",
      },
    })

    const result = await createPullRequestWithFiles(baseInput(octokit))

    expect(result.pullUrl).toBe("https://github.com/acme/docs/pull/7")
    expect(octokit.rest.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: expect.stringMatching(/^refs\/heads\/ctxpipe\/confluence-config-/),
        sha: "base-sha",
      }),
    )
    expect(octokit.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "chore(confluence): update sync config.yaml",
        parents: ["feature-base-sha"],
      }),
    )
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        head: expect.stringMatching(/^ctxpipe\/confluence-config-/),
        base: "main",
      }),
    )
  })

  it("initializes an empty repository before opening the config pull request", async () => {
    const octokit = createOctokitMock()
    octokit.rest.git.getRef
      .mockRejectedValueOnce(
        Object.assign(new Error("Git Repository is empty."), { status: 409 }),
      )
      .mockResolvedValueOnce({ data: { object: { sha: "init-commit" } } })
    octokit.rest.git.getCommit.mockResolvedValueOnce({
      data: { tree: { sha: "init-tree" } },
    })
    octokit.rest.git.createBlob
      .mockResolvedValueOnce({ data: { sha: "readme-blob" } })
      .mockResolvedValueOnce({ data: { sha: "config-blob" } })
    octokit.rest.git.createTree
      .mockResolvedValueOnce({ data: { sha: "init-tree" } })
      .mockResolvedValueOnce({ data: { sha: "config-tree" } })
    octokit.rest.git.createCommit
      .mockResolvedValueOnce({ data: { sha: "init-commit" } })
      .mockResolvedValueOnce({ data: { sha: "config-commit" } })
    octokit.rest.pulls.create.mockResolvedValueOnce({
      data: {
        number: 8,
        html_url: "https://github.com/acme/docs/pull/8",
      },
    })

    const result = await createPullRequestWithFiles(baseInput(octokit))

    expect(result.pullUrl).toBe("https://github.com/acme/docs/pull/8")
    expect(octokit.rest.git.createCommit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: "chore: initialize repository",
        parents: [],
      }),
    )
    expect(octokit.rest.git.createRef).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ref: "refs/heads/main",
        sha: "init-commit",
      }),
    )
    expect(octokit.rest.git.createRef).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ref: expect.stringMatching(/^refs\/heads\/ctxpipe\/confluence-config-/),
        sha: "init-commit",
      }),
    )
    expect(octokit.rest.git.createTree).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tree: [
          expect.objectContaining({
            path: "README.md",
            sha: "readme-blob",
          }),
        ],
      }),
    )
  })

  it("returns an actionable setup error when the GitHub App cannot write refs", async () => {
    const octokit = createOctokitMock()
    octokit.rest.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: "base-sha" } },
    })
    octokit.rest.git.getCommit.mockResolvedValueOnce({
      data: { tree: { sha: "base-tree" } },
    })
    octokit.rest.git.createRef.mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
      }),
    )

    await expect(createPullRequestWithFiles(baseInput(octokit))).rejects.toThrow(
      /GitHub App installation cannot create branches, commits, or pull requests for this repository[\s\S]*Contents: Read & write and Pull requests: Read & write/,
    )
  })
})
