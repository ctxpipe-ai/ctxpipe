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
  compareCommitsTouchesPath,
  getCommitTimestamp,
  getFileContentBytes,
  getPullRequestHeadBranch,
  listFilesAtSha,
} from "./installation-write-client.js"

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
