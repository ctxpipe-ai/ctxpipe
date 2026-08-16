import { describe, expect, it } from "vitest"
import {
  applyResolvedDesiredSha,
  indexPublishTargets,
  reconcileProjectionJobs,
  sandboxSnapshotKey,
  shouldActivateHydrateProjection,
  shouldPersistWebhookAfterAsDesiredSha,
  shouldPublishIndex,
  tipCheckNeedsResolve,
  workspaceIndexJobs,
} from "./revision.js"

describe("desired SHA", () => {
  it("follows the resolved tip, including rewind", () => {
    expect(applyResolvedDesiredSha("aaa")).toBe("aaa")
    expect(applyResolvedDesiredSha(" older ")).toBe("older")
    expect(tipCheckNeedsResolve("aaa", "bbb")).toBe(true)
    expect(tipCheckNeedsResolve("aaa", "aaa")).toBe(false)
    expect(shouldPersistWebhookAfterAsDesiredSha()).toBe(false)
  })

  it("keys the sandbox snapshot by URL plus SHA, not a branch name", () => {
    expect(sandboxSnapshotKey("https://github.com/acme/docs", "abc")).toBe(
      "https://github.com/acme/docs@abc",
    )
    expect(sandboxSnapshotKey("https://github.com/acme/docs", null)).toBeNull()
  })
})

describe("shouldActivateHydrateProjection", () => {
  const ok = {
    jobGeneration: 2,
    desiredGeneration: 2,
    jobWorkspaceUrl: "https://github.com/acme/b",
    desiredWorkspaceUrl: "https://github.com/acme/b",
    jobWorkspaceId: "ws_1",
    desiredWorkspaceId: "ws_1",
    hydratedSha: "bbb",
    desiredSha: "bbb",
  }

  it("activates only when generation, URL, and SHA still match", () => {
    expect(shouldActivateHydrateProjection(ok)).toEqual({ activate: true })
  })

  it("discards a slower hydrate of A after desired moved to B", () => {
    expect(
      shouldActivateHydrateProjection({
        ...ok,
        jobWorkspaceUrl: "https://github.com/acme/a",
        hydratedSha: "aaa",
      }),
    ).toEqual({ activate: false, reason: "url" })
    expect(
      shouldActivateHydrateProjection({ ...ok, jobGeneration: 1 }),
    ).toEqual({ activate: false, reason: "generation" })
    expect(
      shouldActivateHydrateProjection({ ...ok, hydratedSha: "aaa" }),
    ).toEqual({ activate: false, reason: "sha" })
    expect(
      shouldActivateHydrateProjection({
        ...ok,
        jobWorkspaceId: "ws_other",
      }),
    ).toEqual({ activate: false, reason: "workspace" })
  })
})

describe("shouldPublishIndex", () => {
  const ok = {
    jobGeneration: 2,
    desiredGeneration: 2,
    jobWorkspaceUrl: "https://github.com/acme/b",
    desiredWorkspaceUrl: "https://github.com/acme/b",
    jobDesiredSha: "bbb",
    currentDesiredSha: "bbb",
    remoteStillMember: true,
  }

  it("publishes when membership, generation, URL, and SHA match", () => {
    expect(shouldPublishIndex(ok)).toEqual({ publish: true })
  })

  it("keeps the last complete index when the job is stale", () => {
    expect(shouldPublishIndex({ ...ok, remoteStillMember: false })).toEqual({
      publish: false,
      reason: "membership",
    })
    expect(shouldPublishIndex({ ...ok, currentDesiredSha: "ccc" })).toEqual({
      publish: false,
      reason: "sha",
    })
  })
})

describe("reconcileProjectionJobs", () => {
  it("enqueues hydrate and index independently", () => {
    expect(
      reconcileProjectionJobs({
        desiredSha: "bbb",
        desiredUrl: "https://github.com/acme/b",
        activeProjectionUrl: "https://github.com/acme/a",
        activeProjectionSha: "aaa",
        indexedSha: "aaa",
      }),
    ).toEqual({ enqueueHydrate: true, enqueueIndex: true })
    expect(
      reconcileProjectionJobs({
        desiredSha: "bbb",
        desiredUrl: "https://github.com/acme/b",
        activeProjectionUrl: "https://github.com/acme/b",
        activeProjectionSha: "bbb",
        indexedSha: "aaa",
      }),
    ).toEqual({ enqueueHydrate: false, enqueueIndex: true })
  })

  it("does not enqueue until a tip has been resolved", () => {
    expect(
      reconcileProjectionJobs({
        desiredSha: null,
        desiredUrl: "https://github.com/acme/b",
        activeProjectionUrl: null,
        activeProjectionSha: null,
        indexedSha: null,
      }),
    ).toEqual({ enqueueHydrate: false, enqueueIndex: false })
  })
})

describe("indexPublishTargets", () => {
  const normalizeUrl = (url: string) => url.replace(/\.git$/i, "")

  it("publishes matching workspace and linked rows for the indexed SHA", () => {
    expect(
      indexPublishTargets({
        gitUrl: "https://github.com/acme/app.git",
        indexedSha: "bbb",
        normalizeUrl,
        workspaces: [
          {
            id: "ws_app",
            workspaceRepositoryUrl: "https://github.com/acme/app",
            desiredGeneration: 2,
            desiredSha: "bbb",
          },
          {
            id: "ws_other",
            workspaceRepositoryUrl: "https://github.com/acme/other",
            desiredGeneration: 1,
            desiredSha: "bbb",
          },
        ],
        linked: [
          {
            id: "wlr_1",
            workspaceId: "ws_docs",
            gitUrl: "https://github.com/acme/app.git",
            desiredSha: "bbb",
            desiredRef: "main",
            desiredGeneration: 3,
            workspaceUrl: "https://github.com/acme/docs",
          },
          {
            id: "wlr_stale",
            workspaceId: "ws_docs",
            gitUrl: "https://github.com/acme/app.git",
            desiredSha: "aaa",
            desiredRef: "main",
            desiredGeneration: 3,
            workspaceUrl: "https://github.com/acme/docs",
          },
        ],
      }),
    ).toEqual([
      {
        workspaceId: "ws_app",
        role: "workspace",
        expectedGeneration: 2,
        expectedUrl: "https://github.com/acme/app",
        expectedDesiredSha: "bbb",
      },
      {
        workspaceId: "ws_docs",
        role: "linked",
        linkedId: "wlr_1",
        expectedGeneration: 3,
        expectedUrl: "https://github.com/acme/docs",
        expectedLinkedUrl: "https://github.com/acme/app.git",
        expectedLinkedRef: "main",
        expectedDesiredSha: "bbb",
      },
    ])
  })
})

describe("workspaceIndexJobs", () => {
  it("enqueues only remotes whose indexed SHA lags the desired SHA", () => {
    expect(
      workspaceIndexJobs({
        workspaceId: "ws_1",
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        desiredSha: "bbb",
        indexedSha: "aaa",
        linked: [
          {
            id: "wlr_1",
            gitUrl: "https://github.com/acme/app",
            desiredSha: "ccc",
            indexedSha: "ccc",
          },
          {
            id: "wlr_2",
            gitUrl: "https://github.com/acme/lib",
            desiredSha: "ddd",
            indexedSha: null,
          },
        ],
      }),
    ).toEqual([
      {
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
        desiredSha: "bbb",
        role: "workspace",
      },
      {
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/lib",
        desiredSha: "ddd",
        role: "linked",
        linkedId: "wlr_2",
      },
    ])
  })
})
