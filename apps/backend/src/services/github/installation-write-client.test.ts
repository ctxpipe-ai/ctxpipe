import { beforeEach, describe, expect, it, vi } from "vitest"

const getInstallationOctokitForOrgMock = vi.hoisted(() => vi.fn())
const compareCommitsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

import type { Env } from "../../config/env.js"
import { compareCommitsTouchesPath } from "./installation-write-client.js"

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
