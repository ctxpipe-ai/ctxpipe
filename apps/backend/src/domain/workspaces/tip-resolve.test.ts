import { describe, expect, it, vi } from "vitest"
import {
  applyResolvedTipsForMatchingWorkspaces,
  cronTipCheckNeedsHydrate,
  desiredShaFromResolvedTip,
  isDefaultBranchPush,
  runCronLinkedTipChecks,
  runCronTipChecks,
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

  it("updates only workspaces whose resolved tip moved", async () => {
    const persist = vi.fn(async () => true)
    const updatedIds = await runCronTipChecks({
      workspaces: [
        {
          id: "ws_stale",
          workspaceRepositoryUrl: "https://github.com/acme/docs.git",
          desiredGeneration: 1,
          desiredSha: "old",
        },
        {
          id: "ws_fresh",
          workspaceRepositoryUrl: "https://github.com/acme/app.git",
          desiredGeneration: 1,
          desiredSha: "same",
        },
      ],
      resolveTip: async (url) => (url.includes("docs") ? "new-tip" : "same"),
      persist,
    })
    expect(updatedIds).toEqual(["ws_stale"])
    expect(persist).toHaveBeenCalledWith({
      workspaceId: "ws_stale",
      resolvedTip: "new-tip",
      expectedGeneration: 1,
      expectedUrl: "https://github.com/acme/docs.git",
    })
  })

  it("updates linked remotes without re-hydrating the workspace repository", async () => {
    const persist = vi.fn(async () => true)
    const updated = await runCronLinkedTipChecks({
      linked: [
        {
          id: "wlr_1",
          workspaceId: "ws_1",
          gitUrl: "https://github.com/acme/app",
          desiredRef: "main",
          desiredSha: "old",
        },
      ],
      resolveTip: async () => "new-linked",
      persist,
    })
    expect(updated).toEqual([{ linkedId: "wlr_1", resolvedTip: "new-linked" }])
    expect(persist).toHaveBeenCalledWith({
      linkedId: "wlr_1",
      resolvedTip: "new-linked",
      expectedDesiredSha: "old",
    })
  })
})
