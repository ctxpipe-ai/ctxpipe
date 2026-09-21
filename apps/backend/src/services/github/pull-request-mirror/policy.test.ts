import { describe, expect, it } from "vitest"
import type { GithubPrMirrorRepoConfig } from "./config-yaml.js"
import {
  isGithubPullRequestRepositoryInScope,
  shouldMirrorGithubPullRequest,
} from "./policy.js"

const config: GithubPrMirrorRepoConfig = {
  repositories: ["acme/api"],
  states: ["merged"],
  includeDrafts: false,
  maxPullRequestsPerRepository: 100,
}

describe("shouldMirrorGithubPullRequest", () => {
  it("accepts a merged pull request on a listed repository", () => {
    expect(
      shouldMirrorGithubPullRequest({
        config,
        candidate: {
          repository: "acme/api",
          merged: true,
          draft: false,
          updatedAt: "2026-03-02T11:00:00.000Z",
        },
      }),
    ).toBe(true)
  })

  it("rejects open pull requests when the config is merged-only", () => {
    expect(
      shouldMirrorGithubPullRequest({
        config,
        candidate: {
          repository: "acme/api",
          merged: false,
          draft: false,
          updatedAt: "2026-03-02T11:00:00.000Z",
        },
      }),
    ).toBe(false)
  })

  it("rejects a repository before any snapshot when it is not in the yaml list", () => {
    expect(
      isGithubPullRequestRepositoryInScope({
        config,
        repository: "acme/worker",
      }),
    ).toBe(false)
    expect(
      isGithubPullRequestRepositoryInScope({
        config,
        repository: "acme/api",
      }),
    ).toBe(true)
  })

  it("rejects repositories that are not in the yaml list", () => {
    expect(
      shouldMirrorGithubPullRequest({
        config,
        candidate: {
          repository: "acme/worker",
          merged: true,
          draft: false,
          updatedAt: "2026-03-02T11:00:00.000Z",
        },
      }),
    ).toBe(false)
  })
})
