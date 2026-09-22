import { describe, expect, it } from "vitest"
import {
  isCtxpipeContextRepositoryName,
  pickGithubPrMirrorTarget,
  sourceRepositoriesForPrMirror,
} from "./source-scope.js"

describe("sourceRepositoriesForPrMirror", () => {
  it("follows the picker and drops the context warehouse", () => {
    expect(
      sourceRepositoriesForPrMirror(
        [
          "acme/worker",
          "acme/api",
          "acme/ctxpipe-context",
          "acme/api",
        ],
        "acme/ctxpipe-context",
      ),
    ).toEqual(["acme/api", "acme/worker"])
  })
})

describe("pickGithubPrMirrorTarget", () => {
  it("keeps an existing bind", () => {
    expect(
      pickGithubPrMirrorTarget({
        existing: {
          repositoryId: "repo_bound",
          repositoryName: "acme/ctxpipe-context",
          branch: "main",
        },
        connectorTargets: [
          {
            repositoryId: "repo_linear",
            repositoryName: "acme/other",
            branch: "main",
          },
        ],
        ctxpipeContextRepos: [],
      }),
    ).toEqual({
      repositoryId: "repo_bound",
      repositoryName: "acme/ctxpipe-context",
      branch: "main",
    })
  })

  it("uses a connector context repo, then ctxpipe-context", () => {
    expect(
      pickGithubPrMirrorTarget({
        existing: null,
        connectorTargets: [
          {
            repositoryId: "repo_linear",
            repositoryName: "acme/ctxpipe-context",
            branch: "main",
          },
        ],
        ctxpipeContextRepos: [],
      })?.repositoryId,
    ).toBe("repo_linear")
    expect(
      pickGithubPrMirrorTarget({
        existing: null,
        connectorTargets: [],
        ctxpipeContextRepos: [
          {
            repositoryId: "repo_ctx",
            repositoryName: "acme/ctxpipe-context",
            branch: "main",
          },
        ],
      })?.repositoryId,
    ).toBe("repo_ctx")
    expect(
      pickGithubPrMirrorTarget({
        existing: null,
        connectorTargets: [],
        ctxpipeContextRepos: [],
      }),
    ).toBeNull()
  })
})

describe("isCtxpipeContextRepositoryName", () => {
  it("matches the dedicated warehouse name", () => {
    expect(isCtxpipeContextRepositoryName("acme/ctxpipe-context")).toBe(true)
    expect(isCtxpipeContextRepositoryName("ctxpipe-context")).toBe(true)
    expect(isCtxpipeContextRepositoryName("acme/api")).toBe(false)
  })
})
