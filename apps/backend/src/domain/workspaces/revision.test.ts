import { describe, expect, it } from "vitest"
import {
  applyResolvedDesiredSha,
  reconcileProjectionJobs,
  sandboxSnapshotKey,
  shouldActivateHydrateProjection,
  shouldPersistWebhookAfterAsDesiredSha,
  shouldPublishIndex,
  tipCheckNeedsResolve,
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
