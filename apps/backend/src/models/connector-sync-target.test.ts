import { describe, expect, it } from "vitest"
import { chooseSuggestedConnectorSyncTarget } from "./connector-sync-target.js"

describe("chooseSuggestedConnectorSyncTarget", () => {
  it("recommends the single repository shared by existing connectors", () => {
    expect(
      chooseSuggestedConnectorSyncTarget([
        {
          repositoryId: "repo_1",
          repositoryName: "acme/context",
          gitUrl: "https://github.com/acme/context.git",
          branch: "main",
          source: "confluence",
        },
        {
          repositoryId: "repo_1",
          repositoryName: "acme/context",
          gitUrl: "https://github.com/acme/context.git",
          branch: "main",
          source: "notion",
        },
      ]),
    ).toEqual({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      gitUrl: "https://github.com/acme/context.git",
      branch: "main",
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
          source: "confluence",
        },
        {
          repositoryId: "repo_2",
          repositoryName: "acme/other-context",
          gitUrl: "https://github.com/acme/other-context.git",
          branch: "main",
          source: "notion",
        },
      ]),
    ).toBeNull()
  })
})
