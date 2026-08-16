import { describe, expect, it, vi } from "vitest"
import {
  applyResolvedTipsForMatchingWorkspaces,
  cronTipCheckNeedsHydrate,
  desiredShaFromResolvedTip,
  isDefaultBranchPush,
  workspaceMatchesGithubRepo,
} from "./tip-resolve.js"

describe("tip resolve", () => {
  it("ignores webhook after and persists the resolved tip", () => {
    expect(desiredShaFromResolvedTip("real-tip", "payload-after")).toBe(
      "real-tip",
    )
    expect(isDefaultBranchPush("refs/heads/develop", "develop")).toBe(true)
    expect(isDefaultBranchPush("refs/heads/main", "develop")).toBe(false)
  })

  it("matches workspaces by GitHub full name", () => {
    expect(
      workspaceMatchesGithubRepo(
        "https://github.com/acme/docs.git",
        "acme/docs",
      ),
    ).toBe(true)
    expect(
      workspaceMatchesGithubRepo("https://gitlab.com/acme/docs", "acme/docs"),
    ).toBe(false)
  })

  it("enqueues hydrate when cron sees a new tip", () => {
    expect(
      cronTipCheckNeedsHydrate({
        storedDesiredSha: "old",
        resolvedTip: "new",
      }),
    ).toBe(true)
  })

  it("persists the resolved tip and never the webhook after", async () => {
    const persist = vi.fn(async () => true)
    const persisted = await applyResolvedTipsForMatchingWorkspaces({
      repoFullName: "acme/docs",
      defaultBranch: "develop",
      workspaces: [
        {
          id: "ws_1",
          workspaceRepositoryUrl: "https://github.com/acme/docs.git",
          desiredGeneration: 3,
        },
        {
          id: "ws_other",
          workspaceRepositoryUrl: "https://github.com/acme/other.git",
          desiredGeneration: 1,
        },
      ],
      resolveTip: async () => "resolved-tip",
      persist,
    })
    expect(persisted).toBe(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      resolvedTip: "resolved-tip",
      expectedGeneration: 3,
      expectedUrl: "https://github.com/acme/docs.git",
    })
  })
})
