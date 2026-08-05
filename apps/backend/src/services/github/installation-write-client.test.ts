import { beforeEach, describe, expect, it, vi } from "vitest"

const getInstallationOctokitForOrgMock = vi.hoisted(() => vi.fn())
const compareCommitsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

import type { Env } from "../../config/env.js"
import {
  compareCommitsTouchesPath,
  createPullRequestWithFiles,
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
      title: "Configure Slack sync",
      body: "Review and merge.",
      commitMessage: "Configure Slack sync",
      files: [{ path: "slack/config.yaml", content: "channels: []\n" }],
      featureBranchPrefix: "ctxpipe/slack-config",
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
        rest: {
          repos: {
            compareCommits: compareCommitsMock,
          },
        },
      },
    })
  })

  it("passes separate base and head refs to Octokit", async () => {
    compareCommitsMock.mockResolvedValue({
      data: {
        files: [{ filename: "slack/config.yaml" }],
      },
    })

    await expect(
      compareCommitsTouchesPath({
        orgId: "org_1",
        repositoryName: "acme/context",
        env: {} as Env,
        baseSha: "base-sha",
        headSha: "head-sha",
        path: "slack/config.yaml",
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
            filename: "slack/config-archived.yaml",
            previous_filename: "slack/config.yaml",
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
        path: "slack/config.yaml",
      }),
    ).resolves.toBe(true)
  })
})
