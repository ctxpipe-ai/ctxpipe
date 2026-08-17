import { describe, expect, it } from "vitest"
import { buildGitSourceListRows } from "./gitSourcesListRows"
import type { Repository } from "./types"

const indexed = {
  id: "repo_1",
  orgId: "org_acme",
  zoektRepoId: 1,
  name: "acme/web",
  gitUrl: "https://github.com/acme/web.git",
  indexReady: true,
  indexingStatus: "ready",
  indexingError: null,
  indexingFailedAt: null,
  indexingReason: null,
  indexingStep: null,
  indexingStepTotal: null,
  indexingStepKey: null,
  lastIngestedHash: "abc1234",
  lastIngestedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  githubConnectionId: "con_github_1",
} as Repository

describe("buildGitSourceListRows", () => {
  it("puts pending connected, then pending saved, then indexed", () => {
    const rows = buildGitSourceListRows({
      pendingConnected: [
        {
          id: 9,
          full_name: "acme/new",
          html_url: "https://github.com/acme/new",
          clone_url: "https://github.com/acme/new.git",
          name: "new",
        },
      ],
      pendingSaved: [
        {
          name: "acme/saved",
          gitUrl: "https://github.com/acme/saved.git",
        },
      ],
      indexed: [indexed],
    })
    expect(rows.map((row) => row.kind)).toEqual([
      "pending-connected",
      "pending-saved",
      "indexed",
    ])
    expect(rows.map((row) => row.key)).toEqual([
      "pending-connected:9",
      "pending-saved:https://github.com/acme/saved.git",
      "repo_1",
    ])
  })

  it("returns an empty list when every source is empty", () => {
    expect(
      buildGitSourceListRows({
        pendingConnected: [],
        pendingSaved: [],
        indexed: [],
      }),
    ).toEqual([])
  })
})
