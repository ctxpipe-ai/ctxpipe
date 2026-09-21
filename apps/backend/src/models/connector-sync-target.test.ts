import { describe, expect, it } from "vitest"
import {
  chooseSuggestedConnectorSyncTarget,
  suggestConnectorSyncTarget,
} from "./connector-sync-target.js"

describe("chooseSuggestedConnectorSyncTarget", () => {
  it("recommends the single repository shared by existing connectors", () => {
    expect(
      chooseSuggestedConnectorSyncTarget([
        {
          repositoryId: "repo_1",
          repositoryName: "acme/context",
          gitUrl: "https://github.com/acme/context.git",
          branch: "main",
          githubConnectionId: "con_github",
          source: "confluence",
        },
        {
          repositoryId: "repo_1",
          repositoryName: "acme/context",
          gitUrl: "https://github.com/acme/context.git",
          branch: "main",
          githubConnectionId: "con_github",
          source: "notion",
        },
      ]),
    ).toEqual({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      gitUrl: "https://github.com/acme/context.git",
      branch: "main",
      githubConnectionId: "con_github",
      usedBy: ["confluence", "notion"],
    })
  })

  it("does not guess when connectors use different repositories", () => {
    expect(
      chooseSuggestedConnectorSyncTarget([
        {
          repositoryId: "repo_1",
          repositoryName: "acme/context",
          gitUrl: "https://github.com/acme/context.git",
          branch: "main",
          githubConnectionId: "con_github_1",
          source: "confluence",
        },
        {
          repositoryId: "repo_2",
          repositoryName: "acme/other-context",
          gitUrl: "https://github.com/acme/other-context.git",
          branch: "main",
          githubConnectionId: "con_github_2",
          source: "notion",
        },
      ]),
    ).toBeNull()
  })
})

describe("suggestConnectorSyncTarget", () => {
  it("uses a GitHub pull-request bind even when the repo is not named ctxpipe-context", () => {
    expect(
      suggestConnectorSyncTarget({
        connectorCandidates: [
          {
            repositoryId: "repo_demo",
            repositoryName: "acme/ctxpipe-context-demo",
            gitUrl: "https://github.com/acme/ctxpipe-context-demo.git",
            branch: "main",
            githubConnectionId: "con_github",
            source: "github",
          },
        ],
        ctxpipeContextRepos: [
          {
            repositoryId: "repo_ctx",
            repositoryName: "acme/ctxpipe-context",
            gitUrl: "https://github.com/acme/ctxpipe-context.git",
            branch: "main",
            githubConnectionId: "con_github",
          },
        ],
      }),
    ).toEqual({
      repositoryId: "repo_demo",
      repositoryName: "acme/ctxpipe-context-demo",
      gitUrl: "https://github.com/acme/ctxpipe-context-demo.git",
      branch: "main",
      githubConnectionId: "con_github",
      usedBy: ["github"],
    })
  })

  it("falls back to an ingested ctxpipe-context when no connector is bound", () => {
    expect(
      suggestConnectorSyncTarget({
        connectorCandidates: [],
        ctxpipeContextRepos: [
          {
            repositoryId: "repo_ctx",
            repositoryName: "acme/ctxpipe-context",
            gitUrl: "https://github.com/acme/ctxpipe-context.git",
            branch: "main",
            githubConnectionId: "con_github",
          },
        ],
      }),
    ).toEqual({
      repositoryId: "repo_ctx",
      repositoryName: "acme/ctxpipe-context",
      gitUrl: "https://github.com/acme/ctxpipe-context.git",
      branch: "main",
      githubConnectionId: "con_github",
      usedBy: ["github"],
    })
  })

  it("does not override disagreeing connector bindings with ctxpipe-context", () => {
    expect(
      suggestConnectorSyncTarget({
        connectorCandidates: [
          {
            repositoryId: "repo_1",
            repositoryName: "acme/context",
            gitUrl: "https://github.com/acme/context.git",
            branch: "main",
            githubConnectionId: "con_github_1",
            source: "linear",
          },
          {
            repositoryId: "repo_2",
            repositoryName: "acme/other",
            gitUrl: "https://github.com/acme/other.git",
            branch: "main",
            githubConnectionId: "con_github_2",
            source: "notion",
          },
        ],
        ctxpipeContextRepos: [
          {
            repositoryId: "repo_ctx",
            repositoryName: "acme/ctxpipe-context",
            gitUrl: "https://github.com/acme/ctxpipe-context.git",
            branch: "main",
            githubConnectionId: "con_github_1",
          },
        ],
      }),
    ).toBeNull()
  })
})
